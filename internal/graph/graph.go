// Package graph holds codemap's data model: one module shape, one node shape and
// one edge shape for everything. See PLAN.md §3.
package graph

import (
	"bytes"
	"encoding/json"
	"io"
	"sort"
)

// Version is the graph.json format version.
const Version = 1

// Graph is a whole architecture map, or a partial one produced by a single extractor.
type Graph struct {
	Version int      `json:"version"`
	Rev     string   `json:"rev,omitempty"` // commit sha, or "worktree"
	Modules []Module `json:"modules"`
	Nodes   []Node   `json:"nodes"`
	Edges   []Edge   `json:"edges"`
}

// Module groups nodes: a Go package, a TS directory, a database, and so on.
type Module struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Lang     string `json:"lang,omitempty"`
	Path     string `json:"path,omitempty"`
	Doc      string `json:"doc,omitempty"`
	External bool   `json:"external,omitempty"`
}

// Node is anything on the map. Only ID, Kind, Label and Module are required.
// Entry and External are the only flags the viewer interprets; everything else
// lives in Fields and is rendered by what its values look like (PLAN.md §3.3).
type Node struct {
	ID       string         `json:"id"`
	Kind     string         `json:"kind"`
	Label    string         `json:"label"`
	Module   string         `json:"module"`
	File     string         `json:"file,omitempty"`
	Line     int            `json:"line,omitempty"`
	EndLine  int            `json:"endLine,omitempty"`
	Doc      string         `json:"doc,omitempty"`
	Entry    bool           `json:"entry,omitempty"`
	External bool           `json:"external,omitempty"`
	Fields   map[string]any `json:"fields,omitempty"`
}

// Edge connects two nodes. Type is one of the EdgeType constants or any other string.
type Edge struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Type     string `json:"type"`
	Detail   string `json:"detail,omitempty"`
	File     string `json:"file,omitempty"`
	Line     int    `json:"line,omitempty"`
	Declared bool   `json:"declared,omitempty"`
}

// Built-in edge types. Other strings are allowed.
const (
	Calls      = "calls"
	Renders    = "renders"
	Fetches    = "fetches"
	Reads      = "reads"
	Writes     = "writes"
	Publishes  = "publishes"
	Subscribes = "subscribes"
	Declared   = "declared"
)

// Built-in node kinds. These are labels only; any string is allowed.
const (
	KindFunction   = "function"
	KindRoute      = "route"
	KindPage       = "page"
	KindJob        = "job"
	KindSubscriber = "subscriber"
	KindComponent  = "component"
	KindTable      = "table"
	KindTopic      = "topic"
	KindService    = "service"
	KindTest       = "test"
)

func (e Edge) key() string { return e.From + "\x00" + e.To + "\x00" + e.Type }

// Sort orders modules, nodes and edges so output is stable.
func (g *Graph) Sort() {
	sort.Slice(g.Modules, func(i, j int) bool { return g.Modules[i].ID < g.Modules[j].ID })
	sort.Slice(g.Nodes, func(i, j int) bool { return g.Nodes[i].ID < g.Nodes[j].ID })
	sort.Slice(g.Edges, func(i, j int) bool {
		a, b := g.Edges[i], g.Edges[j]
		if a.From != b.From {
			return a.From < b.From
		}
		if a.To != b.To {
			return a.To < b.To
		}
		return a.Type < b.Type
	})
}

// Encode writes the graph as stable, indented JSON.
func (g *Graph) Encode(w io.Writer) error {
	c := *g
	c.Version = Version
	if c.Modules == nil {
		c.Modules = []Module{}
	}
	if c.Nodes == nil {
		c.Nodes = []Node{}
	}
	if c.Edges == nil {
		c.Edges = []Edge{}
	}
	c.Sort()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(&c); err != nil {
		return err
	}
	_, err := w.Write(buf.Bytes())
	return err
}

// Decode reads a graph from JSON.
func Decode(r io.Reader) (*Graph, error) {
	var g Graph
	if err := json.NewDecoder(r).Decode(&g); err != nil {
		return nil, err
	}
	return &g, nil
}
