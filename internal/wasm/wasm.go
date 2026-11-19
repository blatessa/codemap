// Package wasm is what the viewer runs of the graph package, compiled to
// WebAssembly (cmd/codemap-wasm), so the map, its panel and the CLI walk the
// graph with one implementation. The viewer loads the graph it draws (with an
// open proposal's sketch marked Proposed) and asks about nodes in it; edges
// are referred to by their position in that graph.
package wasm

import (
	"encoding/json"

	"github.com/blatessa/codemap/internal/graph"
)

// Loaded is a graph the viewer has loaded.
type Loaded struct {
	ix   *graph.Index
	edge map[*graph.Edge]int
}

// Load parses a graph and indexes it.
func Load(data []byte) (*Loaded, error) {
	var g graph.Graph
	if err := json.Unmarshal(data, &g); err != nil {
		return nil, err
	}
	l := &Loaded{ix: graph.NewIndex(&g), edge: map[*graph.Edge]int{}}
	for i := range g.Edges {
		l.edge[&g.Edges[i]] = i
	}
	return l, nil
}

// Row is one row of a trace, in reading order.
type Row struct {
	ID     string `json:"id"`
	Via    int    `json:"via"`    // the edge into it
	Parent string `json:"parent"` // the row (or root) it's drawn under; not Via's from when forwarding code was skipped
	Depth  int    `json:"depth"`
	Seen   bool   `json:"seen,omitempty"` // shown higher up
	// More is set when the row has calls the trace doesn't go into: it was
	// cut by depth, or it's a shared function.
	More    bool           `json:"more,omitempty"`
	Targets []string       `json:"targets,omitempty"` // a wide call: it may go to any of these
	Support int            `json:"support"`           // support rows left out below it
	Reaches []graph.Effect `json:"reaches"`           // effects reached through code the trace doesn't show
}

// Trace is graph.Trace below a node, flattened for the viewer.
type Trace struct {
	Rows    []Row          `json:"rows"`
	Support int            `json:"support"`
	Reaches []graph.Effect `json:"reaches"`
}

// Trace returns the trace below id.
func (l *Loaded) Trace(id string) Trace {
	t := graph.Trace(l.ix, id)
	out := Trace{Rows: []Row{}, Support: t.Support, Reaches: effects(t.Reaches)}
	var walk func(t *graph.TreeNode, parent string, depth int)
	walk = func(t *graph.TreeNode, parent string, depth int) {
		for _, c := range t.Children {
			r := Row{ID: c.ID, Via: l.edge[c.Via], Parent: parent, Depth: depth, Seen: c.Seen,
				Targets: c.Targets, Support: c.Support, Reaches: effects(c.Reaches)}
			if c.Targets != nil {
				r.ID = c.Targets[0]
			} else if n := l.ix.Node[c.ID]; !c.Seen && len(c.Children) == 0 && c.Support == 0 &&
				n != nil && !n.External && len(l.ix.Out[c.ID]) > 0 {
				r.More = true
			}
			out.Rows = append(out.Rows, r)
			walk(c, c.ID, depth+1)
		}
	}
	walk(t, id, 0)
	return out
}

func effects(fs []graph.Effect) []graph.Effect {
	if fs == nil {
		return []graph.Effect{}
	}
	return fs
}

// Up is what leads to a node, up to the entry points: the nodes, the start
// included, and the edges walked.
type Up struct {
	Nodes []string `json:"nodes"`
	Edges []int    `json:"edges"`
}

// Up walks up from id the way EntriesReaching does.
func (l *Loaded) Up(id string) Up {
	r := l.ix.Up(id, l.ix.StopAtExternalUp(id))
	out := Up{Nodes: []string{}, Edges: []int{}}
	for n := range r.Nodes {
		out.Nodes = append(out.Nodes, n)
	}
	for e := range r.Edges {
		out.Edges = append(out.Edges, l.edge[e])
	}
	return out
}

// Entries returns the entry points that reach id.
func (l *Loaded) Entries(id string) []string {
	out := l.ix.EntriesReaching(id)
	if out == nil {
		return []string{}
	}
	return out
}

// Tests returns the tests of any of ids (graph.Index.TestsReaching).
func (l *Loaded) Tests(ids []string) []graph.TestReach {
	out := l.ix.TestsReaching(ids...)
	if out == nil {
		return []graph.TestReach{}
	}
	return out
}
