package graph

import (
	"sort"
	"strings"
)

// FieldScreen marks frontend code that is part of a page (fields.screen =
// true): the page's components, handlers, hooks and API helpers.
const FieldScreen = "screen"

// FoldScreens makes a frontend page one step of a story. The code a page
// runs (its components, their handlers, hooks and API helpers) is marked as
// part of the screen, and the page gets an edge of its own to everything that
// code reaches outside the frontend: the backend routes it fetches, external
// services, topics. Each new edge keeps the position of the call it stands
// for, and names the code making it in Detail. Traces from a page show its
// effects, not the code in between; tracing from a component still goes
// through it.
func FoldScreens(g *Graph) {
	ix := NewIndex(g)
	part := func(id string) bool {
		n := ix.Node[id]
		return n != nil && !n.External && !n.Entry && n.Kind != KindTest && (n.Kind == KindFunction || n.Kind == KindComponent)
	}
	type key struct{ from, to, typ string }
	have := map[key]bool{}
	for _, e := range g.Edges {
		have[key{e.From, e.To, e.Type}] = true
	}
	marked := map[string]bool{}
	var add []Edge
	for _, p := range g.Nodes {
		if p.Kind != KindPage || p.External {
			continue
		}
		seen := map[string]bool{p.ID: true}
		from := map[string]string{} // how the page's code reached each part
		q := []string{p.ID}
		for len(q) > 0 {
			id := q[0]
			q = q[1:]
			for _, e := range ix.Out[id] {
				if id != p.ID && effectOf(ix, e) && !part(e.To) {
					k := key{p.ID, e.To, e.Type}
					if !have[k] {
						have[k] = true
						add = append(add, Edge{From: p.ID, To: e.To, Type: e.Type, Detail: action(ix, id, from), File: e.File, Line: e.Line})
					}
					continue
				}
				if (e.Type == Calls || e.Type == Renders) && part(e.To) && !seen[e.To] {
					seen[e.To] = true
					from[e.To] = id
					marked[e.To] = true
					q = append(q, e.To)
				}
			}
		}
	}
	sort.SliceStable(add, func(i, j int) bool {
		a, b := add[i], add[j]
		if a.From != b.From {
			return a.From < b.From
		}
		return a.File < b.File || a.File == b.File && a.Line < b.Line
	})
	g.Edges = append(g.Edges, add...)
	for i := range g.Nodes {
		if marked[g.Nodes[i].ID] {
			setField(&g.Nodes[i], FieldScreen, true)
		}
	}
}

// action names what on a screen makes a call: the component nearest the
// call, and its handler or hook ("PlaceOrderButton.onClick", "OrderStatus ·
// useOrder"), not the API helper doing the request.
func action(ix *Index, id string, from map[string]string) string {
	label := func(id string) string {
		if n := ix.Node[id]; n != nil && n.Label != "" {
			return n.Label
		}
		return id
	}
	next := id
	for c := id; c != ""; next, c = c, from[c] {
		n := ix.Node[c]
		if n == nil || n.Kind != KindComponent {
			continue
		}
		if next == c {
			return label(c)
		}
		if l := label(next); strings.HasPrefix(l, label(c)+".") {
			return l
		}
		return label(c) + " · " + label(next)
	}
	return label(id)
}

// effectOf: what a screen's code does outside the frontend.
func effectOf(ix *Index, e *Edge) bool {
	switch e.Type {
	case Fetches, Reads, Writes, Publishes:
		return true
	case Calls:
		n := ix.Node[e.To]
		return n != nil && (n.External || n.Kind == KindRoute)
	}
	return false
}

// OnScreen reports whether a node is part of a page (see FoldScreens).
func OnScreen(n *Node) bool {
	if n == nil {
		return false
	}
	b, _ := n.Fields[FieldScreen].(bool)
	return b
}
