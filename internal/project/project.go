// Package project loads and saves the user state in a repo's .codemap/ directory
// (PLAN.md §4 and §6). Every file is optional.
package project

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"codemap/internal/graph"
)

// Dir is the name of the per-repo state directory.
const Dir = ".codemap"

// Project is everything in .codemap/.
type Project struct {
	Config    Config      `json:"config"`
	Areas     []Area      `json:"areas"`
	Blocks    []Block     `json:"blocks"`
	Layout    Layout      `json:"layout"`
	Views     []View      `json:"views"`
	External  External    `json:"external"`
	Proposals []*Proposal `json:"proposals"`
}

// Area is a user-defined group of modules and blocks.
type Area struct {
	Name    string   `yaml:"name" json:"name"`
	Modules []string `yaml:"modules" json:"modules"`
}

// Block splits nodes out of a module by rules, so new code lands automatically (§4.1).
type Block struct {
	ID    string   `yaml:"id" json:"id"`
	Name  string   `yaml:"name" json:"name"`
	From  string   `yaml:"from" json:"from"`
	Match []string `yaml:"match,omitempty" json:"match,omitempty"` // globs on node label
	Files []string `yaml:"files,omitempty" json:"files,omitempty"` // globs on node file
}

// Layout maps module, block and "area:<name>" IDs to [x, y] positions.
type Layout map[string][2]float64

// View is a saved selection.
type View struct {
	Name      string   `yaml:"name" json:"name"`
	Selection []string `yaml:"selection,omitempty" json:"selection,omitempty"`
	Focus     bool     `yaml:"focus,omitempty" json:"focus,omitempty"`
	Collapsed []string `yaml:"collapsed,omitempty" json:"collapsed,omitempty"`
}

// External is .codemap/external.yaml: declared nodes and edges (§5.6).
// Node entries are free-form maps; see ToGraph.
type External struct {
	Nodes []map[string]any `yaml:"nodes,omitempty" json:"nodes,omitempty"`
	Edges []ExternalEdge   `yaml:"edges,omitempty" json:"edges,omitempty"`
}

// ExternalEdge is a declared edge.
type ExternalEdge struct {
	From   string `yaml:"from" json:"from"`
	To     string `yaml:"to" json:"to"`
	Detail string `yaml:"detail,omitempty" json:"detail,omitempty"`
}

// Load reads <root>/.codemap. A missing directory yields an empty Project.
func Load(root string) (*Project, error) { return LoadFS(os.DirFS(filepath.Join(root, Dir))) }

// LoadFS reads a .codemap directory from any fs.FS (for example a git revision).
func LoadFS(fsys fs.FS) (*Project, error) {
	p := &Project{Layout: Layout{}}
	if err := readYAML(fsys, "config.yaml", &p.Config); err != nil {
		return nil, err
	}
	if err := readYAML(fsys, "areas.yaml", &p.Areas); err != nil {
		return nil, err
	}
	if err := readYAML(fsys, "blocks.yaml", &p.Blocks); err != nil {
		return nil, err
	}
	if err := readYAML(fsys, "views.yaml", &p.Views); err != nil {
		return nil, err
	}
	if err := readYAML(fsys, "external.yaml", &p.External); err != nil {
		return nil, err
	}
	if b, err := fs.ReadFile(fsys, "layout.json"); err == nil {
		if err := json.Unmarshal(b, &p.Layout); err != nil {
			return nil, fmt.Errorf("layout.json: %w", err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
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

func readYAML(fsys fs.FS, name string, v any) error {
	b, err := fs.ReadFile(fsys, name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := yaml.Unmarshal(b, v); err != nil {
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

// MarshalYAML encodes v with two-space indentation.
func MarshalYAML(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), enc.Close()
}

// MarshalLayout encodes a layout as JSON with sorted keys, one entry per line.
func MarshalLayout(l Layout) ([]byte, error) {
	b, err := json.MarshalIndent(l, "", "  ") // encoding/json sorts map keys
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// BlockFor returns the ID of the first block that n falls into, or "" if none.
// A node matches a block when it is in the block's From module and its label
// matches any Match glob or its file matches any Files glob. Globs use path.Match
// syntax, plus "**" matching any number of path segments in Files.
func BlockFor(blocks []Block, n graph.Node) string {
	for _, b := range blocks {
		if b.From != n.Module {
			continue
		}
		for _, g := range b.Match {
			if globMatch(g, n.Label) {
				return b.ID
			}
		}
		if n.File != "" {
			for _, g := range b.Files {
				if globMatch(g, n.File) {
					return b.ID
				}
			}
		}
	}
	return ""
}

// globMatch is path.Match where "**" matches across slashes.
func globMatch(pattern, s string) bool {
	if !strings.Contains(pattern, "**") {
		ok, _ := path.Match(pattern, s)
		return ok
	}
	parts := strings.SplitN(pattern, "**", 2)
	prefix, rest := parts[0], strings.TrimPrefix(parts[1], "/")
	if !strings.HasPrefix(s, prefix) {
		return false
	}
	tail := strings.TrimPrefix(s, prefix)
	if rest == "" {
		return true
	}
	segs := strings.Split(tail, "/")
	for i := range segs {
		if globMatch(rest, strings.Join(segs[i:], "/")) {
			return true
		}
	}
	return false
}

// reserved keys in external.yaml node entries; everything else becomes a field.
var reserved = map[string]bool{"id": true, "kind": true, "label": true, "module": true, "external": true, "entry": true}

// ToGraph converts declared nodes and edges into a partial graph for graph.Merge.
//
// An entry whose id already exists in the extracted graph only contributes its
// fields (Merge does that). Call FillDeclaredDefaults to give new entries a kind,
// label and module.
func (x External) ToGraph() *graph.Graph {
	g := &graph.Graph{}
	for _, raw := range x.Nodes {
		id, _ := raw["id"].(string)
		if id == "" {
			continue
		}
		n := graph.Node{ID: id, Fields: map[string]any{}}
		n.Kind, _ = raw["kind"].(string)
		n.Label, _ = raw["label"].(string)
		n.Module, _ = raw["module"].(string)
		n.External = true
		if v, ok := raw["external"].(bool); ok {
			n.External = v
		}
		n.Entry, _ = raw["entry"].(bool)
		for k, v := range raw {
			if !reserved[k] {
				n.Fields[k] = v
			}
		}
		if len(n.Fields) == 0 {
			n.Fields = nil
		}
		g.Nodes = append(g.Nodes, n)
	}
	for _, e := range x.Edges {
		g.Edges = append(g.Edges, graph.Edge{From: e.From, To: e.To, Type: graph.Declared, Detail: e.Detail, Declared: true})
	}
	return g
}

// FillDeclaredDefaults gives declared nodes that are new (not in extracted) a kind,
// label and module, and adds the "mod:declared" module when needed. Call it on the
// result of ToGraph before merging.
func FillDeclaredDefaults(declared *graph.Graph, extracted *graph.Graph) {
	exists := map[string]bool{}
	for _, n := range extracted.Nodes {
		exists[n.ID] = true
	}
	need := false
	for i := range declared.Nodes {
		n := &declared.Nodes[i]
		if exists[n.ID] {
			continue
		}
		if n.Kind == "" {
			n.Kind = graph.KindService
		}
		if n.Label == "" {
			n.Label = strings.TrimPrefix(n.ID, "ext:")
		}
		if n.Module == "" {
			n.Module = "mod:declared"
			need = true
		}
	}
	if need {
		declared.Modules = append(declared.Modules, graph.Module{ID: "mod:declared", Label: "declared", External: true})
	}
}
