package main

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Skill is one skill the hub can distribute.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Path is the skill's directory, the one holding SKILL.md.
	Path string `json:"path"`
	// Origin is "store" for skills installed into the store and "local"
	// for those of a linked folder.
	Origin string `json:"origin"`
	// Source is the package the skill came from (store) or the linked
	// folder (local).
	Source string `json:"source"`
	Group  string `json:"group"`
	// Hash identifies the skill's contents; see hashDir.
	Hash string `json:"hash"`
	// Conflict marks a skill whose name is taken by an earlier one. It
	// cannot be installed, since targets hold one directory per name.
	Conflict bool `json:"conflict"`
	// Claude and Codex are "auto" or "manual": whether that agent may load
	// the skill on its own. Trigger sums them up, "mixed" when they differ.
	Claude  string `json:"claude"`
	Codex   string `json:"codex"`
	Trigger string `json:"trigger"`
	// Override is the user's choice, "" when the skill is as its author
	// made it; AuthorTrigger is then what the author shipped.
	Override      string `json:"override"`
	AuthorTrigger string `json:"authorTrigger"`
}

const ungrouped = "未分组"

// validName reports whether name is usable as one directory name.
func validName(name string) bool {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00\n\r\t") {
		return false
	}
	return true
}

func isSkillDir(dir string) bool {
	st, err := os.Stat(filepath.Join(dir, "SKILL.md"))
	return err == nil && st.Mode().IsRegular()
}

// childSkillDirs returns the directories directly inside dir that are skills.
func childSkillDirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if isSkillDir(p) {
			out = append(out, p)
		}
	}
	return out
}

// sourceSkillDirs finds the skills of a linked folder: the folder itself, its
// children, or the usual skills directories inside it.
func sourceSkillDirs(dir string) []string {
	if isSkillDir(dir) {
		return []string{dir}
	}
	out := childSkillDirs(dir)
	for _, sub := range []string{"skills", ".agents/skills", ".claude/skills"} {
		out = append(out, childSkillDirs(filepath.Join(dir, sub))...)
	}
	return out
}

// frontmatter reads the name and description of a SKILL.md.
func frontmatter(path string) (name, desc string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", ""
	}
	fields := map[string]string{}
	for i := 1; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "---" {
			break
		}
		if line == "" || line[0] == ' ' || line[0] == '\t' || line[0] == '#' {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		// Block scalars (>, |) and plain values continued on indented lines.
		if val == "" || strings.HasPrefix(val, ">") || strings.HasPrefix(val, "|") {
			val = ""
		}
		for i+1 < len(lines) && (strings.HasPrefix(lines[i+1], " ") || strings.HasPrefix(lines[i+1], "\t")) {
			i++
			val = strings.TrimSpace(val + " " + strings.TrimSpace(lines[i]))
		}
		if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
			val = val[1 : len(val)-1]
		}
		fields[strings.TrimSpace(key)] = val
	}
	return fields["name"], fields["description"]
}

// walkSkill calls fn for every regular file of a skill directory, with its
// slash-separated path relative to dir. It skips what never belongs to a
// skill's contents, and symlinks. hashDir, the copies and scanScript must
// agree on this set of files.
func walkSkill(dir string, fn func(rel string, path string, info fs.FileInfo) error) error {
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || d.Name() == ".DS_Store" || d.Name() == ".git" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		return fn(rel, path, info)
	})
}

// hashDir is the content hash of a skill directory. It equals what scanScript
// computes with find, sort and sha256sum, so copies on any machine compare
// against it.
func hashDir(dir string) (string, error) {
	type file struct{ rel, path string }
	var files []file
	err := walkSkill(dir, func(rel, path string, _ fs.FileInfo) error {
		files = append(files, file{"./" + rel, path})
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].rel < files[j].rel })
	all := sha256.New()
	for _, f := range files {
		h := sha256.New()
		r, err := os.Open(f.path)
		if err != nil {
			return "", err
		}
		_, err = io.Copy(h, r)
		r.Close()
		if err != nil {
			return "", err
		}
		fmt.Fprintf(all, "%s  %s\n", hex.EncodeToString(h.Sum(nil)), f.rel)
	}
	return hex.EncodeToString(all.Sum(nil)), nil
}

// copySkill copies a skill's files into dst, replacing what is there.
func copySkill(src, dst string) error {
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	return walkSkill(src, func(rel, path string, info fs.FileInfo) error {
		out := filepath.Join(dst, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		r, err := os.Open(path)
		if err != nil {
			return err
		}
		defer r.Close()
		w, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
		if err != nil {
			return err
		}
		if _, err := io.Copy(w, r); err != nil {
			w.Close()
			return err
		}
		return w.Close()
	})
}

// tarSkills writes the skills to w as a tar archive with one top-level
// directory per skill.
func tarSkills(w io.Writer, skills []Skill) error {
	tw := tar.NewWriter(w)
	for _, s := range skills {
		err := walkSkill(s.Path, func(rel, path string, info fs.FileInfo) error {
			hdr := &tar.Header{
				Name:    s.Name + "/" + rel,
				Mode:    int64(info.Mode().Perm()),
				Size:    info.Size(),
				ModTime: info.ModTime(),
				Format:  tar.FormatPAX,
			}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			r, err := os.Open(path)
			if err != nil {
				return err
			}
			defer r.Close()
			_, err = io.Copy(tw, r)
			return err
		})
		if err != nil {
			return err
		}
	}
	return tw.Close()
}

// lockSources reads which package each store skill came from.
func lockSources(store string) map[string]string {
	out := map[string]string{}
	data, err := os.ReadFile(filepath.Join(store, "skills-lock.json"))
	if err != nil {
		return out
	}
	var lock struct {
		Skills map[string]struct {
			Source string `json:"source"`
		} `json:"skills"`
	}
	if json.Unmarshal(data, &lock) == nil {
		for name, s := range lock.Skills {
			out[name] = s.Source
		}
	}
	return out
}

// scanSkills lists the skills of the store and of the linked folders.
func scanSkills(cfg *Config) []Skill {
	skills := []Skill{}
	seen := map[string]bool{}
	add := func(dir, origin, source, defaultGroup string) {
		name := filepath.Base(dir)
		fmName, desc := frontmatter(filepath.Join(dir, "SKILL.md"))
		// A linked folder that is itself one skill may be named anything.
		if origin == "local" && fmName != "" && validName(fmName) {
			name = fmName
		}
		s := Skill{Name: name, Description: desc, Path: dir, Origin: origin, Source: source, Group: defaultGroup}
		if g := cfg.Groups[name]; g != "" {
			s.Group = g
		}
		s.Hash, _ = hashDir(dir)
		s.Conflict = seen[name]
		s.Claude, s.Codex = readTrigger(dir)
		s.Trigger = combineTrigger(s.Claude, s.Codex)
		s.AuthorTrigger = s.Trigger
		if o, ok := cfg.Triggers[name]; ok && !s.Conflict {
			s.Override = o.Mode
			if o.OrigClaude != "" {
				s.AuthorTrigger = combineTrigger(o.OrigClaude, o.OrigCodex)
			}
		}
		seen[name] = true
		skills = append(skills, s)
	}

	sources := lockSources(cfg.StorePath)
	for _, dir := range childSkillDirs(filepath.Join(cfg.StorePath, ".agents", "skills")) {
		src := sources[filepath.Base(dir)]
		group := src
		if group == "" {
			group = ungrouped
		}
		add(dir, "store", src, group)
	}
	for _, src := range cfg.Sources {
		for _, dir := range sourceSkillDirs(src.Path) {
			add(dir, "local", src.Path, filepath.Base(src.Path))
		}
	}
	sort.SliceStable(skills, func(i, j int) bool {
		if skills[i].Group != skills[j].Group {
			return skills[i].Group < skills[j].Group
		}
		return skills[i].Name < skills[j].Name
	})
	return skills
}
