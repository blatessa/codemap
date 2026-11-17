package graph

import "sort"

// Index is a read-only lookup structure over a graph, used by queries, the server
// and the CLI.
type Index struct {
	G       *Graph
	Node    map[string]*Node
	Module  map[string]*Module
	Out     map[string][]*Edge
	In      map[string][]*Edge
	ByLabel map[string][]string // label -> node IDs
}

// NewIndex builds an Index. The graph must not be modified afterwards.
func NewIndex(g *Graph) *Index {
	ix := &Index{
		G: g, Node: map[string]*Node{}, Module: map[string]*Module{},
		Out: map[string][]*Edge{}, In: map[string][]*Edge{}, ByLabel: map[string][]string{},
	}
	for i := range g.Modules {
		ix.Module[g.Modules[i].ID] = &g.Modules[i]
	}
	for i := range g.Nodes {
		n := &g.Nodes[i]
		ix.Node[n.ID] = n
		ix.ByLabel[n.Label] = append(ix.ByLabel[n.Label], n.ID)
	}
	for i := range g.Edges {
		e := &g.Edges[i]
		ix.Out[e.From] = append(ix.Out[e.From], e)
		ix.In[e.To] = append(ix.In[e.To], e)
	}
	return ix
}

// Skip decides whether a walk should not follow an edge.
type Skip func(e *Edge) bool

// StopAtExternal is the default trace rule: paths don't continue through external
// nodes, except out of the starting node itself.
func (ix *Index) StopAtExternal(start string) Skip {
	return func(e *Edge) bool {
		if e.From == start {
			return false
		}
		n := ix.Node[e.From]
		return n != nil && n.External
	}
}

// StopAtExternalUp is StopAtExternal for upstream walks.
func (ix *Index) StopAtExternalUp(start string) Skip {
	return func(e *Edge) bool {
		if e.To == start {
			return false
		}
		n := ix.Node[e.To]
		return n != nil && n.External
	}
}

// Reach is the result of a walk: the nodes reached (including the start) and the edges used.
type Reach struct {
	Nodes map[string]bool
	Edges map[*Edge]bool
}

// Down walks outgoing edges breadth-first from start.
func (ix *Index) Down(start string, skip Skip) Reach { return ix.walk(start, ix.Out, true, skip) }

// Up walks incoming edges breadth-first from start.
func (ix *Index) Up(start string, skip Skip) Reach { return ix.walk(start, ix.In, false, skip) }

func (ix *Index) walk(start string, adj map[string][]*Edge, down bool, skip Skip) Reach {
	r := Reach{Nodes: map[string]bool{start: true}, Edges: map[*Edge]bool{}}
	q := []string{start}
	for len(q) > 0 {
		n := q[0]
		q = q[1:]
		for _, e := range adj[n] {
			if skip != nil && skip(e) {
				continue
			}
			r.Edges[e] = true
			next := e.To
			if !down {
				next = e.From
			}
			if !r.Nodes[next] {
				r.Nodes[next] = true
				q = append(q, next)
			}
		}
	}
	return r
}

// TreeNode is one row of a call tree.
type TreeNode struct {
	ID       string      `json:"id"`
	Via      *Edge       `json:"via,omitempty"`
	Seen     bool        `json:"seen,omitempty"` // already shown higher up; not expanded again
	Children []*TreeNode `json:"children,omitempty"`
}

// Tree builds the call tree below start, the way the viewer's details panel shows it:
// each node is expanded once, and external nodes are leaves.
func (ix *Index) Tree(start string, maxDepth int) *TreeNode {
	seen := map[string]bool{start: true}
	var build func(id string, depth int) []*TreeNode
	build = func(id string, depth int) []*TreeNode {
		if maxDepth > 0 && depth >= maxDepth {
			return nil
		}
		var out []*TreeNode
		for _, e := range ix.Out[id] {
			t := &TreeNode{ID: e.To, Via: e}
			if seen[e.To] {
				t.Seen = true
			} else {
				seen[e.To] = true
				if n := ix.Node[e.To]; n == nil || !n.External {
					t.Children = build(e.To, depth+1)
				}
			}
			out = append(out, t)
		}
		return out
	}
	return &TreeNode{ID: start, Children: build(start, 0)}
}

// Callers returns the IDs of nodes with an edge into id, sorted.
func (ix *Index) Callers(id string) []string {
	set := map[string]bool{}
	for _, e := range ix.In[id] {
		set[e.From] = true
	}
	return sortedKeys(set)
}

// EntriesReaching returns the entry points that reach id, sorted.
func (ix *Index) EntriesReaching(id string) []string {
	up := ix.Up(id, ix.StopAtExternalUp(id))
	set := map[string]bool{}
	for n := range up.Nodes {
		if nn := ix.Node[n]; nn != nil && nn.Entry && n != id {
			set[n] = true
		}
	}
	return sortedKeys(set)
}

// TestReach reports which tests reach a node. A test's reach follows calls and
// renders edges only, and never crosses fetches edges or external nodes: a frontend
// test mocks the API, and a backend test doesn't exercise a third-party service.
type TestReach struct {
	Test   string `json:"test"`
	Direct bool   `json:"direct"`
}

// TestsReaching returns the tests whose reach includes any of ids.
func (ix *Index) TestsReaching(ids ...string) []TestReach {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	skip := func(e *Edge) bool {
		if e.Type != Calls && e.Type != Renders {
			return true
		}
		n := ix.Node[e.From]
		return n != nil && n.External
	}
	var out []TestReach
	for _, n := range ix.G.Nodes {
		if n.Kind != KindTest {
			continue
		}
		direct := false
		for _, e := range ix.Out[n.ID] {
			if want[e.To] {
				direct = true
			}
		}
		r := ix.Down(n.ID, skip)
		hit := false
		for id := range want {
			if r.Nodes[id] {
				hit = true
				break
			}
		}
		if hit {
			out = append(out, TestReach{Test: n.ID, Direct: direct})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Test < out[j].Test })
	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
