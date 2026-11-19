package graph

import (
	"strings"
	"testing"
)

// a small frontend: Shell renders List, whose Delete handler calls an API
// helper that fetches a route; Unused renders nothing and reaches nothing.
func screensGraph(page bool) *Graph {
	g := &Graph{
		Nodes: []Node{
			{ID: "ts:Shell", Kind: KindComponent, Label: "Shell", File: "web/Shell.tsx"},
			{ID: "ts:List", Kind: KindComponent, Label: "List", File: "web/screens/List.tsx"},
			{ID: "ts:List.onDelete", Kind: KindFunction, Label: "List.onDelete", File: "web/screens/List.tsx"},
			{ID: "ts:api.del", Kind: KindFunction, Label: "del", File: "web/api.ts"},
			{ID: "ts:Unused", Kind: KindComponent, Label: "Unused", File: "web/Unused.tsx"},
			{ID: "route:DELETE /items/:id", Kind: KindRoute, Label: "/items/:id", Entry: true},
		},
		Edges: []Edge{
			{From: "ts:Shell", To: "ts:List", Type: Renders},
			{From: "ts:List", To: "ts:List.onDelete", Type: Calls},
			{From: "ts:List.onDelete", To: "ts:api.del", Type: Calls},
			{From: "ts:api.del", To: "route:DELETE /items/:id", Type: Fetches, File: "web/api.ts", Line: 3},
		},
	}
	if page {
		g.Nodes = append(g.Nodes, Node{ID: "page:/items", Kind: KindPage, Label: "/items", Entry: true})
		g.Edges = append(g.Edges, Edge{From: "page:/items", To: "ts:Shell", Type: Renders})
	}
	return g
}

func folded(g *Graph) (roots []string, edges []string) {
	for _, n := range g.Nodes {
		if b, _ := n.Fields[FieldScreenRoot].(bool); b {
			roots = append(roots, n.ID)
		}
	}
	for _, e := range g.Edges {
		if e.Type == Fetches && !strings.HasPrefix(e.From, "ts:api") {
			edges = append(edges, e.From+" "+e.Detail)
		}
	}
	return
}

func TestFoldScreens(t *testing.T) {
	for _, c := range []struct {
		name         string
		page         bool
		isScreen     func(string) bool
		roots, edges string
	}{
		// a router's pages are the screens
		{"pages", true, nil, "page:/items", "page:/items List.onDelete"},
		// no pages: the top component that leads somewhere is the screen, not dead code
		{"top component", false, nil, "ts:Shell", "ts:Shell List.onDelete"},
		// configured: components in the matching files
		{"configured", false, func(f string) bool { return strings.HasPrefix(f, "web/screens/") }, "ts:List", "ts:List List.onDelete"},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := screensGraph(c.page)
			FoldScreens(g, c.isScreen)
			roots, edges := folded(g)
			if got := strings.Join(roots, ","); got != c.roots {
				t.Errorf("roots = %s, want %s", got, c.roots)
			}
			if got := strings.Join(edges, ","); got != c.edges {
				t.Errorf("fetches = %s, want %s", got, c.edges)
			}
			ix := NewIndex(g)
			if !OnScreen(ix.Node["ts:api.del"]) {
				t.Error("the API helper should be part of the screen")
			}
			if r := ix.Node[strings.Split(c.roots, ",")[0]]; !r.Entry {
				t.Error("a screen is an entry point")
			}
		})
	}
}
