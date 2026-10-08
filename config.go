package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Target is a place skills get installed to: the global skills of a machine
// or a project directory, on this machine or on an SSH host.
type Target struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Host is an SSH destination (e.g. an alias of ~/.ssh/config). Empty
	// means this machine.
	Host string `json:"host"`
	// Path is the project directory. Unused for global targets, which
	// live in the home directory.
	Path   string `json:"path"`
	Global bool   `json:"global"`
	// Mode is "link" (symlink to the hub's copy) or "copy". Remote targets
	// always copy.
	Mode string `json:"mode"`
	// Agents installs into .agents/skills, Claude into .claude/skills.
	Agents bool `json:"agents"`
	Claude bool `json:"claude"`
}

// LocalSource is a folder of the user's own skills that the hub reads in place.
type LocalSource struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

// Config is everything the hub persists.
type Config struct {
	// StorePath is the project directory skills are installed into with
	// `npx skills add`; the hub distributes them from there.
	StorePath string        `json:"storePath"`
	Sources   []LocalSource `json:"sources"`
	Targets   []Target      `json:"targets"`
	// Groups overrides the group a skill is listed under, by skill name.
	Groups map[string]string `json:"groups"`
	// Triggers holds the user's manual/auto choice per skill name.
	Triggers map[string]TriggerOverride `json:"triggers"`
}

const localGlobalID = "local-global"

func hubDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".skills-hub")
}

func configPath() string { return filepath.Join(hubDir(), "config.json") }

func loadConfig() (*Config, error) {
	cfg := &Config{}
	data, err := os.ReadFile(configPath())
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil {
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, err
		}
	}
	if cfg.StorePath == "" {
		cfg.StorePath = filepath.Join(hubDir(), "store")
	}
	if cfg.Groups == nil {
		cfg.Groups = map[string]string{}
	}
	if cfg.Triggers == nil {
		cfg.Triggers = map[string]TriggerOverride{}
	}
	if cfg.Sources == nil {
		cfg.Sources = []LocalSource{}
	}
	hasLocalGlobal := false
	for _, t := range cfg.Targets {
		if t.ID == localGlobalID {
			hasLocalGlobal = true
		}
	}
	if !hasLocalGlobal {
		cfg.Targets = append([]Target{{
			ID: localGlobalID, Name: "全局", Global: true, Mode: "link", Agents: true, Claude: true,
		}}, cfg.Targets...)
	}
	return cfg, nil
}

func (c *Config) save() error {
	if err := os.MkdirAll(hubDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := configPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, configPath())
}

func (c *Config) target(id string) *Target {
	for i := range c.Targets {
		if c.Targets[i].ID == id {
			return &c.Targets[i]
		}
	}
	return nil
}

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// expandHome turns a leading ~ into the home directory of this machine.
func expandHome(p string) string {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	return p
}
