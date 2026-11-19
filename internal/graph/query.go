package graph

import (
	"sort"
	"strings"
	"sync"
)

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

	commonOnce sync.Once
	common     map[Effect]bool
}

// CommonShare is how many of a repo's entry points must share an effect for it
// to be common: something nearly every feature does (opening the store,
// loading the session), which says nothing about any one feature.
const CommonShare = 0.6

// CommonEffects returns the effects more than CommonShare of the entry points
// reach. A repo with fewer than ten entry points has none.
func (ix *Index) CommonEffects() map[Effect]bool {
	ix.commonOnce.Do(func() {
		ix.common = map[Effect]bool{}
		count := map[Effect]int{}
		n := 0
		for _, nd := range ix.G.Nodes {
			if !nd.Entry || nd.Kind == KindTest || nd.Proposed {
				continue
			}
			n++
			for _, f := range ix.EffectsBeneath(nd.ID) {
				count[f]++
			}
		}
		if n < 10 {
			return
		}
		for f, k := range count {
			if float64(k)/float64(n) > CommonShare {
				ix.common[f] = true
			}
		}
	})
	return ix.common
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
		// Only code makes wide calls: a route's, job's or subscriber's edges
		// to its middleware and handler share the registration's position
		// but are separate calls.
		if from := ix.Node[e.From]; !e.Proposed && e.Type == Calls && e.File != "" && e.Line > 0 && from != nil && (from.Kind == KindFunction || from.Kind == KindComponent) {
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

// StopAtExternalUp is StopAtExternal for upstream walks. It also doesn't go
// from code outside the frontend back into a page's own code: the page's
// edge stands for that code's calls out of the frontend (FoldScreens).
func (ix *Index) StopAtExternalUp(start string) Skip {
	return func(e *Edge) bool {
		if ix.Wide(e) {
			return true
		}
		if OnScreen(ix.Node[e.From]) && !OnScreen(ix.Node[e.To]) {
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
	// features detail level (Features).
	Support int `json:"support,omitempty"`
	// Targets is set on a row standing for a wide call (see WideCall): the
	// call may go to any of these, and the row isn't expanded. ID is "".
	Targets []string `json:"targets,omitempty"`
	// Reaches lists effects reached through code the tree doesn't show
	// below this row (cut, support code, a shared function's insides), so a
	// trace never hides a table, service, topic or API it leads to.
	Reaches []Effect `json:"reaches,omitempty"`
}

// Effect is an edge into the outside world: reads or writes a table,
// publishes to a topic, calls an external service, fetches a route, renders a
// server-side screen.
type Effect struct {
	To   string `json:"to"`
	Type string `json:"type"`
}

// IsEffect reports whether e is an effect edge. Rendering a screen is one;
// rendering a component isn't.
func (ix *Index) IsEffect(e *Edge) bool {
	switch e.Type {
	case Reads, Writes, Publishes, Fetches:
		return true
	case Calls:
		n := ix.Node[e.To]
		return n != nil && n.External
	case Renders:
		n := ix.Node[e.To]
		return n != nil && n.Kind == KindScreen
	}
	return false
}

// StopEffect reports whether e, an edge out of a node traces stop at (see
// Stop), is an effect of the code calling that node. A shared function's
// queries and calls are; a screen it renders (an error page, or a sign-in page
// from auth middleware) isn't: a feature's screens are the ones its own code
// names, or nearly every feature would list them.
func (ix *Index) StopEffect(e *Edge) bool { return ix.IsEffect(e) && e.Type != Renders }

// EffectsBeneath returns the effects reachable from id over calls and renders
// edges that aren't wide, and through the routes it fetches, not going into support code or shared functions
// (their own effects count, what they call doesn't), as traces do.
func (ix *Index) EffectsBeneath(id string) []Effect {
	seen := map[string]bool{id: true}
	got := map[Effect]bool{}
	var out []Effect
	q := []string{id}
	for len(q) > 0 {
		x := q[0]
		q = q[1:]
		for _, e := range ix.Out[x] {
			if e.Proposed {
				continue
			}
			if ix.IsEffect(e) {
				if f := (Effect{e.To, e.Type}); !got[f] {
					got[f] = true
					out = append(out, f)
				}
				// a fetched route's own effects are this code's too
				if e.Type == Fetches && !seen[e.To] {
					seen[e.To] = true
					q = append(q, e.To)
				}
				continue
			}
			if e.Type != Calls && e.Type != Renders || ix.Wide(e) || seen[e.To] {
				continue
			}
			n := ix.Node[e.To]
			if n == nil || n.External || n.Kind == KindTest {
				continue
			}
			seen[e.To] = true
			if ix.Stop(e.To) {
				for _, f := range ix.Out[e.To] {
					if ix.StopEffect(f) {
						if g := (Effect{f.To, f.Type}); !got[g] {
							got[g] = true
							out = append(out, g)
						}
					}
				}
				continue
			}
			q = append(q, e.To)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type < out[j].Type
		}
		return out[i].To < out[j].To
	})
	return out
}

// treeRows turns the edges out of (or, up, into) a node into tree rows,
// folding each wide call site into one row whose Targets are its ends.
func (ix *Index) treeRows(edges []*Edge, up bool) []*TreeNode {
	if !up {
		// in the order the code makes the calls, so a trace reads like the code
		edges = append([]*Edge(nil), edges...)
		sort.SliceStable(edges, func(i, j int) bool {
			a, b := edges[i], edges[j]
			// a page's own effects come before the code that makes them, so the
			// story from a page goes on from there (FoldScreens)
			if sa, sb := OnScreen(ix.Node[a.To]), OnScreen(ix.Node[b.To]); sa != sb {
				return sb
			}
			if a.File != b.File {
				return a.File < b.File
			}
			return a.Line < b.Line
		})
	}
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

// TestCalls is how far from a test the code it covers may be: the test calls
// it, or calls a helper that does. Functions nested in another (a component's
// handlers) count as part of it. Further out, nearly every test in a big repo
// reaches nearly everything (through setup, fixtures and shared code), and the
// list stops saying which tests are about this code.
const TestCalls = 2

// TestReach is a test of a node. It follows calls and renders edges only, and
// never crosses fetches edges, external nodes, wide calls or support code
// (utilities and shared functions): a frontend test mocks the API, a backend
// test doesn't exercise a third-party service, a call through err.Error() isn't
// a test of every error, and a test that logs isn't a test of everything that
// logs.
type TestReach struct {
	Test   string `json:"test"`
	Direct bool   `json:"direct"`
	Via    string `json:"via,omitempty"` // the helper between the test and the code
}

// Stop reports whether traces stop at a node: a utility (hidden as support
// code) or a shared function (shown, but not gone into).
func (ix *Index) Stop(id string) bool {
	n := ix.Node[id]
	if n == nil {
		return false
	}
	shared, _ := n.Fields["shared"].(bool)
	return shared || n.Fields["role"] == RoleUtility
}

// TestsReaching returns the tests of any of ids, within TestCalls calls,
// direct ones first. An external node's tests are those of the code using it.
func (ix *Index) TestsReaching(ids ...string) []TestReach {
	found := map[string]TestReach{}
	seen := map[string]bool{}
	frontier := []string{}
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			frontier = append(frontier, id)
		}
	}
	for _, id := range ids {
		// A table, service or topic is tested through the code that uses it.
		if n := ix.Node[id]; n != nil && n.External {
			for _, e := range ix.In[id] {
				if e.Type != Fetches && !ix.Wide(e) && !e.Proposed {
					if from := ix.Node[e.From]; from != nil && !from.External && from.Kind != KindTest {
						add(e.From)
					}
				}
			}
			continue
		}
		add(id)
	}
	for d := 0; d < TestCalls && len(frontier) > 0; d++ {
		var next []string
		for i := 0; i < len(frontier); i++ {
			id := frontier[i]
			for _, e := range ix.In[id] {
				if e.Type != Calls && e.Type != Renders || ix.Wide(e) || e.Proposed {
					continue
				}
				from := ix.Node[e.From]
				if from == nil || from.External {
					continue
				}
				if from.Kind == KindTest {
					if _, ok := found[e.From]; !ok {
						r := TestReach{Test: e.From, Direct: d == 0}
						if d > 0 {
							r.Via = id
						}
						found[e.From] = r
					}
					continue
				}
				if !seen[e.From] && !ix.Stop(e.From) {
					seen[e.From] = true
					if nested(id, e.From) {
						frontier = append(frontier, e.From) // part of it: no extra call
					} else {
						next = append(next, e.From)
					}
				}
			}
		}
		frontier = next
	}
	out := make([]TestReach, 0, len(found))
	for _, r := range found {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Direct != out[j].Direct {
			return out[i].Direct
		}
		return out[i].Test < out[j].Test
	})
	return out
}

// nested reports whether id is a function nested in parent, like a
// component's event handler (ts:…#Button.onClick in ts:…#Button). Go closures
// are already part of the function that defines them.
func nested(id, parent string) bool {
	return strings.HasPrefix(id, parent+".") && strings.Contains(parent, "#")
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
