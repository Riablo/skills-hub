package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fixture builds a store with two skills and a linked folder with one.
func fixture(t *testing.T) (*Config, []Skill) {
	t.Helper()
	root := t.TempDir()
	store := filepath.Join(root, "store")
	write(t, filepath.Join(store, agentsSub, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: >\n  First\n  skill.\n---\nbody")
	write(t, filepath.Join(store, agentsSub, "alpha", "scripts", "run it.sh"), "echo hi")
	write(t, filepath.Join(store, agentsSub, "alpha", ".DS_Store"), "junk")
	write(t, filepath.Join(store, agentsSub, "beta", "SKILL.md"), "---\nname: beta\ndescription: \"Second: skill\"\n---\n")
	write(t, filepath.Join(store, "skills-lock.json"), `{"version":1,"skills":{"alpha":{"source":"acme/skills"}}}`)
	mine := filepath.Join(root, "mine")
	write(t, filepath.Join(mine, "gamma", "SKILL.md"), "---\nname: gamma\ndescription: Local\n---\n")

	cfg := &Config{StorePath: store, Sources: []LocalSource{{ID: "s", Path: mine}}, Groups: map[string]string{"beta": "custom"}}
	return cfg, scanSkills(cfg)
}

func find(items []Installed, name string) *Installed {
	for i := range items {
		if items[i].Name == name {
			return &items[i]
		}
	}
	return nil
}

func TestScanSkills(t *testing.T) {
	_, skills := fixture(t)
	if len(skills) != 3 {
		t.Fatalf("got %d skills", len(skills))
	}
	got := map[string]Skill{}
	for _, s := range skills {
		got[s.Name] = s
	}
	if s := got["alpha"]; s.Description != "First skill." || s.Group != "acme/skills" || s.Origin != "store" {
		t.Errorf("alpha: %+v", s)
	}
	if s := got["beta"]; s.Description != "Second: skill" || s.Group != "custom" {
		t.Errorf("beta: %+v", s)
	}
	if s := got["gamma"]; s.Origin != "local" || s.Group != "mine" {
		t.Errorf("gamma: %+v", s)
	}
}

func TestInstallCopyAndLink(t *testing.T) {
	ctx := context.Background()
	cfg, skills := fixture(t)
	proj := t.TempDir()

	// Copy mode: .agents holds the copy, .claude a relative link to it.
	target := &Target{ID: "p", Path: proj, Mode: "copy", Agents: true, Claude: true}
	if err := installSkills(ctx, target, skills); err != nil {
		t.Fatal(err)
	}
	items, err := scanTarget(ctx, target, skills)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alpha", "beta", "gamma"} {
		it := find(items, name)
		if it == nil || it.State != "synced" || it.Agents != "copy" || it.Claude != "alias" {
			t.Errorf("%s after copy: %+v", name, it)
		}
	}
	if _, err := os.Stat(filepath.Join(proj, claudeSub, "alpha", "scripts", "run it.sh")); err != nil {
		t.Errorf("claude alias does not resolve: %v", err)
	}
	if _, err := os.Stat(filepath.Join(proj, agentsSub, "alpha", ".DS_Store")); err == nil {
		t.Error(".DS_Store was copied")
	}

	// The scan reads the installed copies' triggers like readTrigger does.
	for _, it := range items {
		if it.Trigger != "auto" {
			t.Errorf("%s trigger: %q", it.Name, it.Trigger)
		}
	}
	setClaudeTrigger(filepath.Join(proj, agentsSub, "beta"), "manual")
	setCodexTrigger(filepath.Join(proj, agentsSub, "gamma"), "manual")
	setClaudeTrigger(filepath.Join(proj, agentsSub, "gamma"), "manual")
	items, _ = scanTarget(ctx, target, skills)
	if got := find(items, "beta").Trigger; got != "mixed" {
		t.Errorf("beta trigger: %q", got)
	}
	if got := find(items, "gamma").Trigger; got != "manual" {
		t.Errorf("gamma trigger: %q", got)
	}
	if got := find(items, "alpha").Trigger; got != "auto" {
		t.Errorf("alpha trigger: %q", got)
	}
	if err := installSkills(ctx, target, skills); err != nil {
		t.Fatal(err)
	}

	// The hub's skill changes: the copy is outdated until reinstalled.
	write(t, filepath.Join(cfg.StorePath, agentsSub, "alpha", "SKILL.md"), "---\nname: alpha\n---\nv2")
	skills = scanSkills(cfg)
	items, _ = scanTarget(ctx, target, skills)
	if it := find(items, "alpha"); it.State != "outdated" {
		t.Errorf("alpha after change: %+v", it)
	}
	if it := find(items, "beta"); it.State != "synced" {
		t.Errorf("beta after change: %+v", it)
	}

	// Something the hub does not know is foreign.
	write(t, filepath.Join(proj, agentsSub, "other", "SKILL.md"), "x")
	items, _ = scanTarget(ctx, target, skills)
	if it := find(items, "other"); it == nil || it.State != "foreign" {
		t.Errorf("other: %+v", it)
	}

	// Link mode replaces the copies with symlinks to the hub's skills.
	target.Mode = "link"
	if err := installSkills(ctx, target, skills[:1]); err != nil {
		t.Fatal(err)
	}
	items, _ = scanTarget(ctx, target, skills)
	first := skills[0].Name
	if it := find(items, first); it.State != "linked" || it.Agents != "link" || it.Claude != "link" {
		t.Errorf("%s after link: %+v", first, it)
	}

	if err := uninstallSkills(ctx, target, []string{first, "other"}, skills); err != nil {
		t.Fatal(err)
	}
	items, _ = scanTarget(ctx, target, skills)
	if find(items, first) != nil || find(items, "other") != nil {
		t.Errorf("still installed: %+v", items)
	}
	if _, err := os.Stat(skills[0].Path); err != nil {
		t.Errorf("uninstalling a link removed the hub's skill: %v", err)
	}
}

// A linked folder that is the target's own skills directory must survive
// both installing into and uninstalling from that target.
func TestSourceInsideTarget(t *testing.T) {
	ctx := context.Background()
	proj := t.TempDir()
	write(t, filepath.Join(proj, agentsSub, "own", "SKILL.md"), "---\nname: own\n---\n")
	cfg := &Config{StorePath: filepath.Join(proj, "nostore"), Sources: []LocalSource{{ID: "s", Path: filepath.Join(proj, agentsSub)}}, Groups: map[string]string{}}
	skills := scanSkills(cfg)
	if len(skills) != 1 {
		t.Fatalf("got %d skills", len(skills))
	}
	target := &Target{ID: "p", Path: proj, Mode: "link", Agents: true, Claude: true}
	if err := installSkills(ctx, target, skills); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(proj, agentsSub, "own", "SKILL.md")); err != nil {
		t.Fatalf("source destroyed by install: %v", err)
	}
	items, _ := scanTarget(ctx, target, skills)
	if it := find(items, "own"); it == nil || it.State != "linked" && it.State != "synced" {
		t.Errorf("own: %+v", it)
	}
	if err := uninstallSkills(ctx, target, []string{"own"}, skills); err == nil {
		t.Error("uninstall removed a source directory")
	}
	if _, err := os.Stat(filepath.Join(proj, agentsSub, "own", "SKILL.md")); err != nil {
		t.Fatalf("source destroyed by uninstall: %v", err)
	}
}

// Remote installs need a reachable host: SKILLS_HUB_TEST_HOST=name go test
func TestRemote(t *testing.T) {
	host := os.Getenv("SKILLS_HUB_TEST_HOST")
	if host == "" {
		t.Skip("SKILLS_HUB_TEST_HOST not set")
	}
	ctx := context.Background()
	_, skills := fixture(t)
	dir := "/tmp/skills-hub-test-" + newID()
	if _, err := runScript(ctx, host, "mkdir "+shq(dir), nil); err != nil {
		t.Fatal(err)
	}
	defer runScript(ctx, host, "rm -rf "+shq(dir), nil)

	target := &Target{ID: "r", Host: host, Path: dir, Mode: "copy", Agents: true, Claude: true}
	if err := installSkills(ctx, target, skills); err != nil {
		t.Fatal(err)
	}
	items, err := scanTarget(ctx, target, skills)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alpha", "beta", "gamma"} {
		if it := find(items, name); it == nil || it.State != "synced" || it.Claude != "alias" {
			t.Errorf("%s: %+v", name, it)
		}
	}
	if err := uninstallSkills(ctx, target, []string{"alpha"}, skills); err != nil {
		t.Fatal(err)
	}
	items, _ = scanTarget(ctx, target, skills)
	if find(items, "alpha") != nil || find(items, "beta") == nil {
		t.Errorf("after uninstall: %+v", items)
	}
}

func TestTriggerOverride(t *testing.T) {
	cfg, _ := fixture(t)
	cfg.Triggers = map[string]TriggerOverride{}
	alpha := filepath.Join(cfg.StorePath, agentsSub, "alpha")
	beta := filepath.Join(cfg.StorePath, agentsSub, "beta")
	get := func(name string) Skill {
		for _, s := range scanSkills(cfg) {
			if s.Name == name {
				return s
			}
		}
		t.Fatalf("no skill %s", name)
		return Skill{}
	}
	if s := get("alpha"); s.Trigger != "auto" || s.Override != "" {
		t.Fatalf("alpha at first: %+v", s)
	}

	// Auto by its author, manual by the user: both agents' files say so.
	cfg.Triggers["alpha"] = TriggerOverride{Mode: "manual"}
	if _, err := applyOverrides(cfg); err != nil {
		t.Fatal(err)
	}
	if s := get("alpha"); s.Claude != "manual" || s.Codex != "manual" || s.Override != "manual" || s.AuthorTrigger != "auto" {
		t.Errorf("alpha overridden: %+v", s)
	}
	if name, desc := frontmatter(filepath.Join(alpha, "SKILL.md")); name != "alpha" || desc != "First skill." {
		t.Errorf("frontmatter damaged: %q %q", name, desc)
	}

	// An update from the source replaces the files; the choice comes back,
	// and the new contents stay.
	write(t, filepath.Join(alpha, "SKILL.md"), "---\nname: alpha\ndescription: v2\n---\nnew body")
	os.RemoveAll(filepath.Join(alpha, "agents"))
	if changed, err := applyOverrides(cfg); err != nil || !changed {
		t.Fatal(changed, err)
	}
	if s := get("alpha"); s.Trigger != "manual" || s.Description != "v2" {
		t.Errorf("alpha after update: %+v", s)
	}
	if changed, _ := applyOverrides(cfg); changed {
		t.Error("applyOverrides is not idempotent")
	}

	// Manual by its author, with other settings in openai.yaml: auto by
	// the user keeps the rest of both files.
	write(t, filepath.Join(beta, "SKILL.md"), "---\nname: beta\ndisable-model-invocation: true\ndescription: B\n---\nbody")
	write(t, filepath.Join(beta, "agents", "openai.yaml"), "interface:\n  display_name: \"Beta\"\npolicy:\n  allow_implicit_invocation: false\n")
	if s := get("beta"); s.Trigger != "manual" {
		t.Fatalf("beta by author: %+v", s)
	}
	cfg.Triggers["beta"] = TriggerOverride{Mode: "auto"}
	applyOverrides(cfg)
	s := get("beta")
	if s.Trigger != "auto" || s.AuthorTrigger != "manual" || s.Description != "B" {
		t.Errorf("beta overridden: %+v", s)
	}
	yaml, _ := os.ReadFile(filepath.Join(beta, "agents", "openai.yaml"))
	if string(yaml) != "interface:\n  display_name: \"Beta\"\npolicy:\n  allow_implicit_invocation: true\n" {
		t.Errorf("openai.yaml: %q", yaml)
	}

	// A policy block without the key, and no trailing newline.
	write(t, filepath.Join(beta, "agents", "openai.yaml"), "policy:\ninterface:\n  display_name: x")
	setCodexTrigger(beta, "manual")
	yaml, _ = os.ReadFile(filepath.Join(beta, "agents", "openai.yaml"))
	if string(yaml) != "policy:\n  allow_implicit_invocation: false\ninterface:\n  display_name: x" {
		t.Errorf("openai.yaml with empty policy: %q", yaml)
	}
}
