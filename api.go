package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Hub is the service the frontend calls.
type Hub struct {
	mu  sync.Mutex
	cfg *Config
}

// State is what the frontend renders from.
type State struct {
	Config Config  `json:"config"`
	Skills []Skill `json:"skills"`
	Home   string  `json:"home"`
}

func (h *Hub) snapshot() (Config, []Skill) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cfg := *h.cfg
	cfg.Targets = append([]Target{}, h.cfg.Targets...)
	cfg.Sources = append([]LocalSource{}, h.cfg.Sources...)
	cfg.Groups = map[string]string{}
	for k, v := range h.cfg.Groups {
		cfg.Groups[k] = v
	}
	cfg.Triggers = map[string]TriggerOverride{}
	for k, v := range h.cfg.Triggers {
		cfg.Triggers[k] = v
	}
	return cfg, scanSkills(&cfg)
}

// update changes the config under the lock and saves it.
func (h *Hub) update(fn func(cfg *Config) error) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := fn(h.cfg); err != nil {
		return err
	}
	return h.cfg.save()
}

// State returns the config and the skills of the store and linked folders.
func (h *Hub) State() State {
	// Skills may have been updated since, by the hub or by hand: put the
	// user's manual/auto choices back first.
	h.mu.Lock()
	if changed, _ := applyOverrides(h.cfg); changed {
		h.cfg.save()
	}
	h.mu.Unlock()
	cfg, skills := h.snapshot()
	home, _ := os.UserHomeDir()
	return State{Config: cfg, Skills: skills, Home: home}
}

// ScanTarget lists what is installed in a target. Failures, such as an
// unreachable host, are reported in the status.
func (h *Hub) ScanTarget(ctx context.Context, id string) TargetStatus {
	cfg, skills := h.snapshot()
	st := TargetStatus{TargetID: id, Items: []Installed{}}
	t := cfg.target(id)
	if t == nil {
		st.Error = "目标不存在"
		return st
	}
	items, err := scanTarget(ctx, t, skills)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	st.Items = items
	return st
}

// Install installs or refreshes the named skills in a target.
func (h *Hub) Install(ctx context.Context, targetID string, names []string) error {
	cfg, skills := h.snapshot()
	t := cfg.target(targetID)
	if t == nil {
		return errors.New("目标不存在")
	}
	var picked []Skill
	for _, n := range names {
		found := false
		for _, s := range skills {
			if s.Name == n && !s.Conflict {
				picked = append(picked, s)
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("技能 %q 不在仓库中", n)
		}
	}
	return installSkills(ctx, t, picked)
}

// Uninstall removes the named skills from a target.
func (h *Hub) Uninstall(ctx context.Context, targetID string, names []string) error {
	cfg, skills := h.snapshot()
	t := cfg.target(targetID)
	if t == nil {
		return errors.New("目标不存在")
	}
	return uninstallSkills(ctx, t, names, skills)
}

// AddProject adds a project directory, on this machine when host is empty.
func (h *Hub) AddProject(ctx context.Context, host, path, name string) (Target, error) {
	host, path, name = strings.TrimSpace(host), strings.TrimSpace(path), strings.TrimSpace(name)
	if path == "" {
		return Target{}, errors.New("请填写项目路径")
	}
	t := Target{ID: newID(), Name: name, Host: host, Path: path, Mode: "copy", Agents: true, Claude: true}
	if host == "" {
		t.Path = expandHome(path)
		if st, err := os.Stat(t.Path); err != nil || !st.IsDir() {
			return Target{}, fmt.Errorf("目录不存在: %s", t.Path)
		}
	} else {
		ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if _, err := runScript(ctx, host, "B="+shellBase(&t)+`; [ -d "$B" ] || { echo "目录不存在: $B" >&2; exit 1; }`, nil); err != nil {
			return Target{}, err
		}
	}
	if t.Name == "" {
		t.Name = filepath.Base(t.Path)
	}
	err := h.update(func(cfg *Config) error {
		for _, o := range cfg.Targets {
			if !o.Global && o.Host == t.Host && o.Path == t.Path {
				return errors.New("这个项目已经添加过了")
			}
		}
		cfg.Targets = append(cfg.Targets, t)
		return nil
	})
	return t, err
}

// AddHost adds the global skills of an SSH host, after checking that the
// host is reachable.
func (h *Hub) AddHost(ctx context.Context, host string) (Target, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return Target{}, errors.New("请填写主机")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := runScript(ctx, host, "true", nil); err != nil {
		return Target{}, fmt.Errorf("无法连接 %s: %w", host, err)
	}
	t := Target{ID: newID(), Name: "全局", Host: host, Global: true, Mode: "copy", Agents: true, Claude: true}
	err := h.update(func(cfg *Config) error {
		for _, o := range cfg.Targets {
			if o.Global && o.Host == host {
				return errors.New("这台主机已经添加过了")
			}
		}
		cfg.Targets = append(cfg.Targets, t)
		return nil
	})
	return t, err
}

// UpdateTarget changes a target's name, install mode and directories.
func (h *Hub) UpdateTarget(t Target) error {
	if t.Mode != "link" && t.Mode != "copy" {
		return errors.New("无效的安装方式")
	}
	return h.update(func(cfg *Config) error {
		cur := cfg.target(t.ID)
		if cur == nil {
			return errors.New("目标不存在")
		}
		if cur.Host != "" {
			t.Mode = "copy" // a symlink cannot cross machines
		}
		if name := strings.TrimSpace(t.Name); name != "" {
			cur.Name = name
		}
		cur.Mode, cur.Agents, cur.Claude = t.Mode, t.Agents, t.Claude
		return nil
	})
}

// RemoveTarget forgets a target. Its installed skills stay on disk.
func (h *Hub) RemoveTarget(id string) error {
	if id == localGlobalID {
		return errors.New("本机全局不能移除")
	}
	return h.update(func(cfg *Config) error {
		out := cfg.Targets[:0]
		for _, t := range cfg.Targets {
			if t.ID != id {
				out = append(out, t)
			}
		}
		cfg.Targets = out
		return nil
	})
}

// PickFolder shows a directory picker and returns the chosen path, or "".
func (h *Hub) PickFolder(ctx context.Context) (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:            mygo.CallerWindow(ctx),
		Directory:         true,
		ShowHiddenFiles:   true,
		CreateDirectories: true,
	})
	if err != nil || len(paths) == 0 {
		return "", err
	}
	return paths[0], nil
}

// AddSource links a local folder of skills.
func (h *Hub) AddSource(path string) error {
	path = expandHome(path)
	if st, err := os.Stat(path); err != nil || !st.IsDir() {
		return fmt.Errorf("目录不存在: %s", path)
	}
	if len(sourceSkillDirs(path)) == 0 {
		return errors.New("这个文件夹里没有找到技能（含 SKILL.md 的目录）")
	}
	return h.update(func(cfg *Config) error {
		for _, s := range cfg.Sources {
			if s.Path == path {
				return errors.New("这个文件夹已经关联过了")
			}
		}
		cfg.Sources = append(cfg.Sources, LocalSource{ID: newID(), Path: path})
		return nil
	})
}

// RemoveSource unlinks a local folder. Nothing is deleted.
func (h *Hub) RemoveSource(id string) error {
	return h.update(func(cfg *Config) error {
		out := cfg.Sources[:0]
		for _, s := range cfg.Sources {
			if s.ID != id {
				out = append(out, s)
			}
		}
		cfg.Sources = out
		return nil
	})
}

// SetStorePath moves the hub to another store directory. The old one is
// left as it is.
func (h *Hub) SetStorePath(path string) error {
	path = expandHome(path)
	if path == "" || !filepath.IsAbs(path) {
		return errors.New("请填写绝对路径")
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}
	return h.update(func(cfg *Config) error {
		cfg.StorePath = path
		return nil
	})
}

// SetGroup lists the named skills under group. An empty group restores the
// default, the package or folder a skill came from.
func (h *Hub) SetGroup(names []string, group string) error {
	group = strings.TrimSpace(group)
	return h.update(func(cfg *Config) error {
		for _, n := range names {
			if group == "" {
				delete(cfg.Groups, n)
			} else {
				cfg.Groups[n] = group
			}
		}
		return nil
	})
}

// SetTrigger makes the named skills manual or auto in both Claude Code and
// Codex, whatever their sources say now or after an update. An empty mode
// drops the choice and restores what the author shipped.
func (h *Hub) SetTrigger(names []string, mode string) error {
	if mode != "" && mode != "manual" && mode != "auto" {
		return errors.New("无效的触发方式")
	}
	return h.update(func(cfg *Config) error {
		if mode != "" {
			for _, n := range names {
				o := cfg.Triggers[n]
				o.Mode = mode
				cfg.Triggers[n] = o
			}
			_, err := applyOverrides(cfg)
			return err
		}
		var first error
		for _, s := range scanSkills(cfg) {
			o, ok := cfg.Triggers[s.Name]
			if !ok || s.Conflict || !slices.Contains(names, s.Name) {
				continue
			}
			if o.OrigClaude != "" {
				if err := setClaudeTrigger(s.Path, o.OrigClaude); err != nil && first == nil {
					first = err
				}
				if err := setCodexTrigger(s.Path, o.OrigCodex); err != nil && first == nil {
					first = err
				}
			}
		}
		for _, n := range names {
			delete(cfg.Triggers, n)
		}
		return first
	})
}

// ReadSkill returns the SKILL.md of a skill.
func (h *Hub) ReadSkill(name string) (string, error) {
	_, skills := h.snapshot()
	for _, s := range skills {
		if s.Name == name {
			data, err := os.ReadFile(filepath.Join(s.Path, "SKILL.md"))
			return string(data), err
		}
	}
	return "", errors.New("技能不存在")
}

// OpenPath opens a file or directory of this machine with its default app.
func (h *Hub) OpenPath(path string) error {
	return mygo.Shell.OpenPath(expandHome(path))
}

// SSHHosts lists the host aliases of ~/.ssh/config.
func (h *Hub) SSHHosts() []string {
	hosts := []string{}
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		return hosts
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || !strings.EqualFold(f[0], "host") {
			continue
		}
		for _, name := range f[1:] {
			if !strings.ContainsAny(name, "*?!") {
				hosts = append(hosts, name)
			}
		}
	}
	return hosts
}

// ---- The store ----

var (
	ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07`)
	// skillsAddRe matches the install commands skills.sh shows, so that
	// pasting one works like typing its package.
	skillsAddRe = regexp.MustCompile(`^(?:npx|bunx|pnpx|pnpm\s+dlx)\s+(?:(?:-y|--yes)\s+)?skills(?:@\S+)?\s+(?:add|a)\s+(.+)$`)
	runnerRe    = regexp.MustCompile(`^(npx|bunx|pnpx|pnpm|npm|bun|git|gh|uvx|curl)\s`)
)

// stream runs a command in the store and sends its output to log line by line.
func (h *Hub) stream(ctx context.Context, log *mygo.Channel[string], name string, args ...string) error {
	h.mu.Lock()
	store := h.cfg.StorePath
	h.mu.Unlock()
	if err := os.MkdirAll(store, 0o755); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	log.Send("$ " + name + " " + strings.Join(args, " "))
	env := append(commandEnv(), "CI=1") // before exec.Command: it settles PATH
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = store
	cmd.Env = env
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			for _, line := range strings.Split(sc.Text(), "\r") {
				line = strings.TrimRight(ansiRe.ReplaceAllString(line, ""), " ")
				if strings.TrimSpace(line) != "" {
					log.Send(line)
				}
			}
		}
		io.Copy(io.Discard, pr)
	}()
	err := cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return errors.New("命令超时")
		}
		return fmt.Errorf("命令失败: %w", err)
	}
	return nil
}

func hasFlag(args []string, flags ...string) bool {
	for _, a := range args {
		for _, f := range flags {
			if a == f {
				return true
			}
		}
	}
	return false
}

// StoreInstall installs skills into the store. spec is a package for
// `skills add` (a GitHub repository, a URL…), optionally followed by its
// flags, or a whole install command. Skills that are new or changed
// afterwards are listed under group when one is given.
func (h *Hub) StoreInstall(ctx context.Context, spec, group string, log *mygo.Channel[string]) error {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return errors.New("请填写要安装的包")
	}
	_, before := h.snapshot()

	var err error
	rest := spec
	if m := skillsAddRe.FindStringSubmatch(spec); m != nil {
		rest = m[1]
	}
	if rest == spec && runnerRe.MatchString(spec) {
		// Some other command: run it as written, in the store.
		err = h.stream(ctx, log, "sh", "-c", spec)
	} else {
		args := []string{"-y", "skills", "add"}
		for _, a := range strings.Fields(rest) {
			if a != "-g" && a != "--global" {
				args = append(args, a)
			}
		}
		if !hasFlag(args, "-a", "--agent", "--all") {
			args = append(args, "-a", "universal")
		}
		if !hasFlag(args[1:], "-y", "--yes", "--all") {
			args = append(args, "-y")
		}
		err = h.stream(ctx, log, "npx", args...)
	}
	if err != nil {
		return err
	}

	if group = strings.TrimSpace(group); group != "" {
		old := map[string]string{}
		for _, s := range before {
			if s.Origin == "store" {
				old[s.Name] = s.Hash
			}
		}
		_, after := h.snapshot()
		var names []string
		for _, s := range after {
			if hash, ok := old[s.Name]; s.Origin == "store" && (!ok || hash != s.Hash) {
				names = append(names, s.Name)
			}
		}
		return h.SetGroup(names, group)
	}
	return nil
}

// StoreUpdate updates the named store skills to their latest versions, or
// all of them when names is empty.
func (h *Hub) StoreUpdate(ctx context.Context, names []string, log *mygo.Channel[string]) error {
	args := []string{"-y", "skills", "update"}
	for _, n := range names {
		if !validName(n) || strings.HasPrefix(n, "-") {
			return fmt.Errorf("无效的技能名 %q", n)
		}
		args = append(args, n)
	}
	return h.stream(ctx, log, "npx", append(args, "-p", "-y")...)
}

// StoreRemove deletes the named skills from the store. Copies and links in
// targets are not touched.
func (h *Hub) StoreRemove(ctx context.Context, names []string, log *mygo.Channel[string]) error {
	args := []string{"-y", "skills", "remove"}
	for _, n := range names {
		if !validName(n) || strings.HasPrefix(n, "-") {
			return fmt.Errorf("无效的技能名 %q", n)
		}
		args = append(args, n)
	}
	err := h.stream(ctx, log, "npx", append(args, "-y")...)
	// Whatever the CLI did, the directories must be gone.
	h.mu.Lock()
	store := h.cfg.StorePath
	h.mu.Unlock()
	for _, n := range names {
		if rmErr := os.RemoveAll(filepath.Join(store, agentsSub, n)); rmErr != nil && err == nil {
			err = rmErr
		}
	}
	if err == nil {
		err = h.update(func(cfg *Config) error {
			for _, n := range names {
				delete(cfg.Groups, n)
				delete(cfg.Triggers, n)
			}
			return nil
		})
	}
	return err
}
