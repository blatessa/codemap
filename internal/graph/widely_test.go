package graph

import (
	"fmt"
	"testing"
)

// widelyUsedGraph: ten callers use tx (no effects of its own, but it calls
// begin, which writes) and save (writes), and h makes one call that may reach
// six implementations. Filler brings the repo to 100 functions, so the top 2%
// by utilityhood is two functions.
func widelyUsedGraph() *Graph {
	g := &Graph{}
	add := func(id string) { g.Nodes = append(g.Nodes, fn("go:x."+id, "m", "m.go", len(g.Nodes)*10+1, len(g.Nodes)*10+20)) }
	call := func(a, b string, line int) {
		g.Edges = append(g.Edges, Edge{From: "go:x." + a, To: "go:x." + b, Type: Calls, File: "m.go", Line: line})
	}
	for _, id := range []string{"tx", "save", "begin", "h"} {
		add(id)
	}
	g.Nodes = append(g.Nodes, Node{ID: "table:t", Kind: KindTable, Label: "t", Module: "db", External: true})
	g.Edges = append(g.Edges, Edge{From: "go:x.save", To: "table:t", Type: Writes}, Edge{From: "go:x.begin", To: "table:t", Type: Writes})
	call("tx", "begin", 1)
	for i := range 10 {
		c := fmt.Sprintf("c%d", i)
		add(c)
		call(c, "tx", 100+i)
		call(c, "save", 200+i)
	}
	for i := range 6 {
		add(fmt.Sprintf("impl%d", i))
		call("h", fmt.Sprintf("impl%d", i), 300)
	}
	for i := 0; len(g.Nodes) < 101; i++ {
		add(fmt.Sprintf("filler%d", i))
	}
	return g
}

func TestWidelyUsed(t *testing.T) {
	g := widelyUsedGraph()
	AssignRoles(g, nil)
	ix := NewIndex(g)
	if r := roleOf(g, "go:x.tx"); r != RoleUtility {
		t.Errorf("tx: role %q, want utility (widely used, no effects of its own)", r)
	}
	if r := roleOf(g, "go:x.save"); r != "" || ix.Node["go:x.save"].Fields["shared"] != true {
		t.Errorf("save: role %q, fields %v; want no role and shared (widely used, writes)", r, ix.Node["go:x.save"].Fields)
	}
	if ix.Node["go:x.begin"].Fields["shared"] == true || roleOf(g, "go:x.begin") != "" {
		t.Errorf("begin has one caller; it isn't widely used")
	}
}

func TestWideCallTree(t *testing.T) {
	ix := NewIndex(widelyUsedGraph())
	tree := ix.Tree("go:x.h", 0)
	if len(tree.Children) != 1 || len(tree.Children[0].Targets) != 6 || tree.Children[0].ID != "" {
		t.Fatalf("want one row for the wide call with 6 targets, got %+v", tree.Children)
	}
	if up := ix.TreeRowsUp(ix.In["go:x.impl3"]); len(up) != 1 || up[0].Targets == nil {
		t.Errorf("up: want one wide row, got %+v", up)
	}
	if r := ix.Down("go:x.h", ix.StopAtExternal("go:x.h")); len(r.Nodes) != 1 {
		t.Errorf("traces don't follow wide calls; reached %v", r.Nodes)
	}
}
