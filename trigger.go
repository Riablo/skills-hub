package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Whether an agent may load a skill on its own ("auto") or only when the
// user asks for it ("manual") is declared per agent:
//
//	Claude Code  SKILL.md frontmatter   disable-model-invocation: true
//	Codex        agents/openai.yaml     policy.allow_implicit_invocation: false
//
// Both default to auto.

// TriggerOverride is the user's choice for a skill, kept in the config so it
// outlives updates of the skill.
type TriggerOverride struct {
	Mode string `json:"mode"` // "manual" or "auto"
	// OrigClaude and OrigCodex are what the skill's author shipped, to
	// show and to restore.
	OrigClaude string `json:"origClaude"`
	OrigCodex  string `json:"origCodex"`
}

var (
	claudeKeyRe = regexp.MustCompile(`^disable-model-invocation:\s*(\S*)`)
	codexKeyRe  = regexp.MustCompile(`(?m)^([ \t]+allow_implicit_invocation:[ \t]*)(\S*)`)
	policyRe    = regexp.MustCompile(`(?m)^policy:[ \t]*\r?$`)
)

func isTrue(v string) bool {
	return strings.EqualFold(strings.Trim(v, `"'`), "true")
}

// frontmatterEnd returns the index of the line closing the frontmatter of a
// SKILL.md split into lines, or -1 when it has none.
func frontmatterEnd(lines []string) int {
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return -1
	}
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			return i
		}
	}
	return -1
}

// combineTrigger sums up the two agents: "auto", "manual" or "mixed".
func combineTrigger(claude, codex string) string {
	if claude == codex {
		return claude
	}
	return "mixed"
}

// readTrigger tells how the skill in dir is triggered in each agent.
func readTrigger(dir string) (claude, codex string) {
	claude, codex = "auto", "auto"
	if data, err := os.ReadFile(filepath.Join(dir, "SKILL.md")); err == nil {
		lines := strings.Split(string(data), "\n")
		for i := 1; i < frontmatterEnd(lines); i++ {
			if m := claudeKeyRe.FindStringSubmatch(lines[i]); m != nil && isTrue(m[1]) {
				claude = "manual"
			}
		}
	}
	if data, err := os.ReadFile(filepath.Join(dir, "agents", "openai.yaml")); err == nil {
		if m := codexKeyRe.FindSubmatch(data); m != nil && strings.EqualFold(strings.Trim(string(m[2]), `"'`), "false") {
			codex = "manual"
		}
	}
	return claude, codex
}

// setClaudeTrigger edits the frontmatter of SKILL.md. Auto only rewrites a
// key that is there, since auto is the default.
func setClaudeTrigger(dir, mode string) error {
	path := filepath.Join(dir, "SKILL.md")
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	value := "false"
	if mode == "manual" {
		value = "true"
	}
	lines := strings.Split(string(data), "\n")
	eol := ""
	if strings.HasSuffix(lines[0], "\r") {
		eol = "\r"
	}
	line := "disable-model-invocation: " + value + eol
	end := frontmatterEnd(lines)
	found := false
	for i := 1; i < end; i++ {
		if claudeKeyRe.MatchString(lines[i]) {
			lines[i] = line
			found = true
		}
	}
	switch {
	case found:
	case mode != "manual":
		return nil
	case end < 0:
		lines = append([]string{"---" + eol, line, "---" + eol}, lines...)
	default:
		lines = append(lines[:end], append([]string{line}, lines[end:]...)...)
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644)
}

// setCodexTrigger edits agents/openai.yaml, creating it when a skill without
// one becomes manual.
func setCodexTrigger(dir, mode string) error {
	path := filepath.Join(dir, "agents", "openai.yaml")
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	text := string(data)
	value := "true"
	if mode == "manual" {
		value = "false"
	}
	const key = "  allow_implicit_invocation: "
	switch {
	case codexKeyRe.MatchString(text):
		text = codexKeyRe.ReplaceAllString(text, "${1}"+value)
	case mode != "manual":
		return nil
	case policyRe.MatchString(text):
		loc := policyRe.FindStringIndex(text)
		text = text[:loc[1]] + "\n" + key + value + text[loc[1]:]
	default:
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		text += "policy:\n" + key + value + "\n"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(text), 0o644)
}

// applyOverrides makes the skills' files say what the user chose. A skill
// that says otherwise was just installed or updated from its source: what it
// says then is the author's setting, which is remembered before rewriting.
// It reports whether the config changed.
func applyOverrides(cfg *Config) (changed bool, err error) {
	if len(cfg.Triggers) == 0 {
		return false, nil
	}
	for _, s := range scanSkills(cfg) {
		o, ok := cfg.Triggers[s.Name]
		if !ok || s.Conflict || (s.Claude == o.Mode && s.Codex == o.Mode) {
			continue
		}
		if s.Claude != o.Mode || o.OrigClaude == "" {
			o.OrigClaude = s.Claude
		}
		if s.Codex != o.Mode || o.OrigCodex == "" {
			o.OrigCodex = s.Codex
		}
		cfg.Triggers[s.Name] = o
		changed = true
		if e := setClaudeTrigger(s.Path, o.Mode); e != nil && err == nil {
			err = e
		}
		if e := setCodexTrigger(s.Path, o.Mode); e != nil && err == nil {
			err = e
		}
	}
	return changed, err
}
