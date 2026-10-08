package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	agentsSub = ".agents/skills"
	claudeSub = ".claude/skills"
)

// Installed describes one skill directory found in a target.
type Installed struct {
	Name string `json:"name"`
	// State is how the entry relates to the hub's skill of that name:
	//   linked    a symlink to the hub's skill, always current
	//   synced    a copy with the same contents
	//   outdated  a copy that differs, or one missing from an enabled directory
	//   conflict  the name is a hub skill's, but the entry links elsewhere
	//   foreign   the hub has no skill of that name
	State string `json:"state"`
	// Agents and Claude tell what sits in each skills directory: "",
	// "link", "copy", or "alias" for .claude's relative link to .agents.
	Agents string `json:"agents"`
	Claude string `json:"claude"`
	// LinkTo is where a symlink points.
	LinkTo string `json:"linkTo"`
	// Trigger is "auto", "manual" or "mixed", read from the installed
	// files: whether agents may load the skill on their own (see trigger.go).
	Trigger string `json:"trigger"`
}

// TargetStatus is the result of scanning a target.
type TargetStatus struct {
	TargetID string      `json:"targetId"`
	Error    string      `json:"error"`
	Items    []Installed `json:"items"`
}

// shq quotes s for a POSIX shell.
func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// userPath is the PATH of the user's login shell. Apps started from the
// Finder get a minimal one, without npx and friends.
var userPath = sync.OnceValue(func() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	path := os.Getenv("PATH") + ":/opt/homebrew/bin:/usr/local/bin"
	out, err := exec.CommandContext(ctx, shell, "-ilc", `printf '__P__%s__P__' "$PATH"`).Output()
	if err == nil {
		if parts := strings.Split(string(out), "__P__"); len(parts) >= 3 && parts[1] != "" {
			path = parts[1]
		}
	}
	// exec.Command looks programs up in this process's PATH, not in the
	// command's environment.
	os.Setenv("PATH", path)
	return path
})

func commandEnv() []string {
	env := []string{"PATH=" + userPath(), "NO_COLOR=1", "FORCE_COLOR=0"}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "PATH=") {
			env = append(env, kv)
		}
	}
	return env
}

func sshArgs(host string) []string {
	return []string{
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=10",
		"-o", "ControlMaster=auto",
		// Kept short: a socket path is limited to about 100 bytes.
		"-o", fmt.Sprintf("ControlPath=/tmp/skills-hub-%d-%%C", os.Getuid()),
		"-o", "ControlPersist=120",
		"--", host,
	}
}

// runScript runs a shell script on this machine, or on host over SSH, and
// returns its standard output.
func runScript(ctx context.Context, host, script string, stdin io.Reader) (string, error) {
	env := commandEnv() // before exec.Command: it settles PATH
	var cmd *exec.Cmd
	if host == "" {
		cmd = exec.CommandContext(ctx, "sh", "-c", script)
	} else {
		if strings.HasPrefix(host, "-") {
			return "", fmt.Errorf("无效的主机名 %q", host)
		}
		cmd = exec.CommandContext(ctx, "ssh", append(sshArgs(host), "sh -c "+shq(script))...)
	}
	cmd.Env = env
	cmd.Stdin = stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return "", errors.New("操作超时")
		}
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return "", errors.New(msg)
		}
		return "", err
	}
	return stdout.String(), nil
}

// localBase is the directory of a target on this machine.
func localBase(t *Target) string {
	if t.Global {
		home, _ := os.UserHomeDir()
		return home
	}
	return expandHome(t.Path)
}

// shellBase is the target's directory as a shell word, for scripts that may
// run on another machine.
func shellBase(t *Target) string {
	if t.Host == "" {
		return shq(localBase(t))
	}
	p := strings.TrimSpace(t.Path)
	switch {
	case t.Global || p == "~":
		return `"$HOME"`
	case strings.HasPrefix(p, "~/"):
		return `"$HOME"/` + shq(strings.TrimPrefix(p, "~/"))
	}
	return shq(p)
}

// scanScript prints one line per entry of the target's skills directories:
// directory, name, kind (link or dir), the link's destination or the
// directory's content hash, and how Claude Code and Codex trigger the skill.
// The hash matches hashDir, the triggers readTrigger.
const scanScript = `
[ -d "$B" ] || { echo "目录不存在: $B" >&2; exit 1; }
H=sha256sum; command -v sha256sum >/dev/null 2>&1 || H="shasum -a 256"
for sub in .agents/skills .claude/skills; do
  d="$B/$sub"
  [ -d "$d" ] || continue
  for e in "$d"/* "$d"/.[!.]*; do
    n=${e##*/}
    c=auto; x=auto
    awk 'NR==1{if($0!~/^---[ \t\r]*$/)exit;next} /^---[ \t\r]*$/{exit} /^disable-model-invocation:[ \t]*.?[Tt][Rr][Uu][Ee]/{f=1;exit} END{exit !f}' "$e/SKILL.md" 2>/dev/null && c=manual
    grep -Eiq '^[ 	]+allow_implicit_invocation:[ 	]*.?false' "$e/agents/openai.yaml" 2>/dev/null && x=manual
    if [ -L "$e" ]; then
      printf '%s\t%s\tlink\t%s\t%s\t%s\n' "$sub" "$n" "$(readlink "$e")" "$c" "$x"
    elif [ -d "$e" ]; then
      h=$(cd "$e" && find . -name .git -prune -o -type f ! -name .DS_Store -print0 | LC_ALL=C sort -z | xargs -0 $H | $H | cut -d' ' -f1)
      printf '%s\t%s\tdir\t%s\t%s\t%s\n' "$sub" "$n" "$h" "$c" "$x"
    fi
  done
done
`

type entry struct {
	kind    string // "link" or "dir"
	value   string // link destination or content hash
	trigger string // "auto", "manual" or "mixed"
}

func scanTarget(ctx context.Context, t *Target, skills []Skill) ([]Installed, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	out, err := runScript(ctx, t.Host, "B="+shellBase(t)+"\n"+scanScript, nil)
	if err != nil {
		return nil, err
	}
	found := map[string]map[string]entry{agentsSub: {}, claudeSub: {}}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 6 || found[f[0]] == nil {
			continue
		}
		found[f[0]][f[1]] = entry{f[2], f[3], combineTrigger(f[4], f[5])}
	}

	byName := map[string]*Skill{}
	for i := range skills {
		if !skills[i].Conflict {
			byName[skills[i].Name] = &skills[i]
		}
	}
	names := map[string]bool{}
	for _, m := range found {
		for n := range m {
			names[n] = true
		}
	}

	items := []Installed{}
	for name := range names {
		it := Installed{Name: name}
		skill := byName[name]
		a, hasA := found[agentsSub][name]
		c, hasC := found[claudeSub][name]

		// state of one entry against the hub's skill
		state := func(sub string, e entry) string {
			if e.kind == "dir" {
				if e.value == skill.Hash {
					return "synced"
				}
				return "outdated"
			}
			if t.Host == "" {
				real, err1 := filepath.EvalSymlinks(filepath.Join(localBase(t), sub, name))
				want, err2 := filepath.EvalSymlinks(skill.Path)
				if err1 == nil && err2 == nil && real == want {
					return "linked"
				}
			}
			return "conflict"
		}
		kindOf := func(e entry) string {
			if e.kind == "link" {
				return "link"
			}
			return "copy"
		}

		it.Trigger = c.trigger
		if hasA {
			it.Trigger = a.trigger
		}

		var states []string
		if hasA {
			it.Agents = kindOf(a)
			if a.kind == "link" {
				it.LinkTo = a.value
			}
			if skill != nil {
				states = append(states, state(agentsSub, a))
			}
		}
		if hasC {
			it.Claude = kindOf(c)
			if c.kind == "link" && c.value == "../../"+agentsSub+"/"+name {
				it.Claude = "alias"
				if !hasA {
					states = append(states, "outdated") // dangling
				}
			} else {
				if c.kind == "link" && it.LinkTo == "" {
					it.LinkTo = c.value
				}
				if skill != nil {
					states = append(states, state(claudeSub, c))
				}
			}
		}
		if (t.Agents && !hasA) || (t.Claude && !hasC) {
			states = append(states, "outdated")
		}

		switch {
		case skill == nil:
			it.State = "foreign"
		case contains(states, "conflict"):
			it.State = "conflict"
		case contains(states, "outdated"):
			it.State = "outdated"
		case contains(states, "synced"):
			it.State = "synced"
		default:
			it.State = "linked"
		}
		items = append(items, it)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// sameDir reports whether two paths are the same directory once symlinks are
// resolved.
func sameDir(a, b string) bool {
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && ra == rb
}

// installSkills puts the skills into the target, replacing entries of the
// same names.
func installSkills(ctx context.Context, t *Target, skills []Skill) error {
	if !t.Agents && !t.Claude {
		return errors.New("这个目标没有启用任何 skills 目录")
	}
	for _, s := range skills {
		if !validName(s.Name) {
			return fmt.Errorf("无效的技能名 %q", s.Name)
		}
	}
	if t.Host != "" {
		return installRemote(ctx, t, skills)
	}

	base := localBase(t)
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		return fmt.Errorf("目录不存在: %s", base)
	}
	// place puts one skill at dst by fn, unless dst already is the skill
	// itself (a linked folder that lives inside the target).
	place := func(s Skill, sub string, fn func(dst string) error) error {
		dir := filepath.Join(base, sub)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		dst := filepath.Join(dir, s.Name)
		if sameDir(dst, s.Path) {
			if _, err := os.Readlink(dst); err != nil {
				return nil // the skill's own directory
			}
		}
		return fn(dst)
	}
	link := func(to string) func(string) error {
		return func(dst string) error {
			if err := os.RemoveAll(dst); err != nil {
				return err
			}
			return os.Symlink(to, dst)
		}
	}

	for _, s := range skills {
		var err error
		if t.Mode == "link" {
			if t.Agents {
				err = place(s, agentsSub, link(s.Path))
			}
			if err == nil && t.Claude {
				err = place(s, claudeSub, link(s.Path))
			}
		} else {
			cp := func(dst string) error { return copySkill(s.Path, dst) }
			switch {
			case t.Agents && t.Claude:
				if err = place(s, agentsSub, cp); err == nil {
					err = place(s, claudeSub, link(filepath.Join("..", "..", agentsSub, s.Name)))
				}
			case t.Agents:
				err = place(s, agentsSub, cp)
			default:
				err = place(s, claudeSub, cp)
			}
		}
		if err != nil {
			return fmt.Errorf("%s: %w", s.Name, err)
		}
	}
	return nil
}

func installRemote(ctx context.Context, t *Target, skills []Skill) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	var names []string
	for _, s := range skills {
		names = append(names, shq(s.Name))
	}
	list := strings.Join(names, " ")
	primary := agentsSub
	if !t.Agents {
		primary = claudeSub
	}
	script := "set -e\nB=" + shellBase(t) + "\n" +
		`[ -d "$B" ] || { echo "目录不存在: $B" >&2; exit 1; }` + "\n" +
		`P="$B/` + primary + `"; mkdir -p "$P"; cd "$P"` + "\n" +
		"rm -rf -- " + list + "\ntar -xf -\n"
	if t.Agents && t.Claude {
		script += `C="$B/` + claudeSub + `"; mkdir -p "$C"` + "\n" +
			"for n in " + list + `; do rm -rf -- "$C/$n"; ln -s "../../` + agentsSub + `/$n" "$C/$n"; done` + "\n"
	}

	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(tarSkills(pw, skills)) }()
	_, err := runScript(ctx, t.Host, script, pr)
	pr.Close()
	return err
}

// uninstallSkills removes the named entries from both skills directories of
// the target. Symlinks are removed, never followed, and a directory that is
// the hub's own source of a skill is refused.
func uninstallSkills(ctx context.Context, t *Target, names []string, skills []Skill) error {
	for _, n := range names {
		if !validName(n) {
			return fmt.Errorf("无效的技能名 %q", n)
		}
	}
	if t.Host == "" {
		base := localBase(t)
		for _, n := range names {
			for _, sub := range []string{agentsSub, claudeSub} {
				p := filepath.Join(base, sub, n)
				if st, err := os.Lstat(p); err == nil && st.IsDir() {
					for _, s := range skills {
						if sameDir(p, s.Path) {
							return fmt.Errorf("%s 是技能的源目录，不能在这里删除", p)
						}
					}
				}
				if err := os.RemoveAll(p); err != nil {
					return err
				}
			}
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	script := "set -e\nB=" + shellBase(t) + "\n"
	for _, n := range names {
		for _, sub := range []string{agentsSub, claudeSub} {
			script += `rm -rf -- "$B/` + sub + `"/` + shq(n) + "\n"
		}
	}
	_, err := runScript(ctx, t.Host, script, nil)
	return err
}
