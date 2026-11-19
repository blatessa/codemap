// Package project loads and saves the user state in a repo's .codemap/ directory
// (config and proposals). Every file is optional.
package project

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// Dir is the name of the per-repo state directory.
const Dir = ".codemap"

// Project is everything in .codemap/.
type Project struct {
	Config    Config      `json:"config"`
	Proposals []*Proposal `json:"proposals"`
	// Warnings are problems in .codemap/ that don't stop it loading, such as
	// keys config.toml doesn't know (a typo maps nothing).
	Warnings []string `json:"-"`
}

// Load reads <root>/.codemap. A missing directory yields an empty Project.
func Load(root string) (*Project, error) { return LoadFS(os.DirFS(filepath.Join(root, Dir))) }

// LoadFS reads a .codemap directory from any fs.FS (for example a git revision).
func LoadFS(fsys fs.FS) (*Project, error) {
	p := &Project{}
	files := []struct {
		name  string
		parse func([]byte) error
	}{
		{"config.toml", func(b []byte) error {
			p.Warnings = append(p.Warnings, UnknownKeys("config.toml", b, &Config{})...)
			return UnmarshalTOML(b, &p.Config)
		}},
	}
	for _, f := range files {
		if err := readFile(fsys, f.name, f.parse); err != nil {
			return nil, err
		}
	}
	entries, err := fs.ReadDir(fsys, "proposals")
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		b, err := fs.ReadFile(fsys, path.Join("proposals", e.Name()))
		if err != nil {
			return nil, err
		}
		pr, err := ParseProposal(b)
		if err != nil {
			return nil, fmt.Errorf("proposals/%s: %w", e.Name(), err)
		}
		pr.Slug = strings.TrimSuffix(e.Name(), ".md")
		p.Proposals = append(p.Proposals, pr)
	}
	sort.Slice(p.Proposals, func(i, j int) bool { return p.Proposals[i].Slug < p.Proposals[j].Slug })
	return p, nil
}

func readFile(fsys fs.FS, name string, parse func([]byte) error) error {
	b, err := fs.ReadFile(fsys, name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := parse(b); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// WriteFile writes one file under <root>/.codemap atomically (write to a temp file, then rename).
func WriteFile(root, name string, data []byte) error {
	full := filepath.Join(root, Dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), ".tmp-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), full)
}
