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
	site    map[*Edge]int       // how many targets each calls edge's call site has
}

// WideCall is how many targets a call site may resolve to before it counts as
// wide: a call through an interface or function value with many
// implementations (err.Error(), a notifier list). Traces show a wide call as
// one step and don't follow it; the edges stay in the graph.
const WideCall = 4

// Wide reports whether e is one of the targets of a wide call site.
func (ix *Index) Wide(e *Edge) bool { return ix.site[e] > WideCall }

// SiteTargets returns how many targets e's call site has (1 for an edge without a position).
func (ix *Index) SiteTargets(e *Edge) int {
	if n := ix.site[e]; n > 0 {
		return n
	}
	return 1
}

// NewIndex builds an Index. The graph must not be modified afterwards.
func NewIndex(g *Graph) *Index {
	ix := &Index{
		G: g, Node: map[string]*Node{}, Module: map[string]*Module{},
		Out: map[string][]*Edge{}, In: map[string][]*Edge{}, ByLabel: map[string][]string{},
		site: map[*Edge]int{},
	}
	for i := range g.Modules {
		ix.Module[g.Modules[i].ID] = &g.Modules[i]
	}
	for i := range g.Nodes {
		n := &g.Nodes[i]
		ix.Node[n.ID] = n
		ix.ByLabel[n.Label] = append(ix.ByLabel[n.Label], n.ID)
	}
	type siteKey struct {
		from, file string
		line       int
	}
	sites := map[siteKey][]*Edge{}
	for i := range g.Edges {
		e := &g.Edges[i]
		ix.Out[e.From] = append(ix.Out[e.From], e)
		ix.In[e.To] = append(ix.In[e.To], e)
		if e.Type == Calls && e.File != "" && e.Line > 0 {
			k := siteKey{e.From, e.File, e.Line}
			sites[k] = append(sites[k], e)
		}
	}
	for _, es := range sites {
		for _, e := range es {
			ix.site[e] = len(es)
		}
	}
	return ix
}

// Skip decides whether a walk should not follow an edge.
type Skip func(e *Edge) bool

// StopAtExternal is the default trace rule: paths don't continue through external
// nodes, except out of the starting node itself, and don't follow wide calls.
func (ix *Index) StopAtExternal(start string) Skip {
	return func(e *Edge) bool {
		if ix.Wide(e) {
			return true
		}
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
		if ix.Wide(e) {
			return true
		}
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
	// Support counts the support rows left out below this one at the
	// features detail level (cli.Features).
	Support int `json:"support,omitempty"`
	// Targets is set on a row standing for a wide call (see WideCall): the
	// call may go to any of these, and the row isn't expanded. ID is "".
	Targets []string `json:"targets,omitempty"`
}

// treeRows turns the edges out of (or, up, into) a node into tree rows,
// folding each wide call site into one row whose Targets are its ends.
func (ix *Index) treeRows(edges []*Edge, up bool) []*TreeNode {
	var out []*TreeNode
	wide := map[[3]any]*TreeNode{}
	for _, e := range edges {
		end := e.To
		if up {
			end = e.From
		}
		if !ix.Wide(e) {
			out = append(out, &TreeNode{ID: end, Via: e})
			continue
		}
		// down, a wide row is one call site; up, one row for all the wide
		// calls that may land here
		k := [3]any{e.From, e.File, e.Line}
		if up {
			k = [3]any{"", "", 0}
		}
		if w := wide[k]; w != nil {
			w.Targets = append(w.Targets, end)
			continue
		}
		w := &TreeNode{Via: e, Targets: []string{end}}
		wide[k] = w
		out = append(out, w)
	}
	return out
}

// Tree builds the call tree below start, the way the viewer's details panel shows it:
// each node is expanded once, external nodes are leaves, and a wide call is
// one row that isn't expanded.
func (ix *Index) Tree(start string, maxDepth int) *TreeNode {
	seen := map[string]bool{start: true}
	var build func(id string, depth int) []*TreeNode
	build = func(id string, depth int) []*TreeNode {
		if maxDepth > 0 && depth >= maxDepth {
			return nil
		}
		out := ix.treeRows(ix.Out[id], false)
		for _, t := range out {
			if t.Targets != nil {
				continue
			}
			if seen[t.ID] {
				t.Seen = true
			} else {
				seen[t.ID] = true
				if n := ix.Node[t.ID]; n == nil || !n.External {
					t.Children = build(t.ID, depth+1)
				}
			}
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
// renders edges only, and never crosses fetches edges, external nodes or wide
// calls: a frontend test mocks the API, a backend test doesn't exercise a
// third-party service, and a call through err.Error() isn't a test of every error.
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
		if e.Type != Calls && e.Type != Renders || ix.Wide(e) {
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

// TreeRowsUp is treeRows for a tree of callers.
func (ix *Index) TreeRowsUp(edges []*Edge) []*TreeNode { return ix.treeRows(edges, true) }
