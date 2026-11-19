package graph

import (
	"testing"
)

func TestCutAndSettle(t *testing.T) {
	// a → b → c → d, and a → d: d is expanded under c first, so the row under
	// a says "see above". Cut at depth 2 drops c's row, and Settle clears it.
	g := &Graph{
		Nodes: []Node{{ID: "a", Kind: "function"}, {ID: "b", Kind: "function"}, {ID: "c", Kind: "function"}, {ID: "d", Kind: "function"}},
		Edges: []Edge{{From: "a", To: "b", Type: "calls"}, {From: "b", To: "c", Type: "calls"}, {From: "c", To: "d", Type: "calls"}, {From: "a", To: "d", Type: "calls"}},
	}
	ix := NewIndex(g)
	full := ix.Tree("a", 0)
	if !full.Children[1].Seen {
		t.Fatal("setup: d under a should be seen")
	}
	cut := Settle(Cut(full, 2))
	if d := cut.Children[1]; d.ID != "d" || d.Seen {
		t.Errorf("d under a: %+v; want shown, not see above", d)
	}
	if len(cut.Children[0].Children) != 1 || cut.Children[0].Children[0].Children != nil {
		t.Errorf("depth 2 keeps b → c and drops c's children")
	}
}

// TestPrune: branches that reach no effect fold into the row above; a tree
// where nothing leads anywhere keeps its first level.
func TestPrune(t *testing.T) {
	fn := func(id string) Node { return Node{ID: id, Kind: KindFunction} }
	g := &Graph{
		Nodes: []Node{fn("h"), fn("parse"), fn("save"), fn("helper"), fn("insert"), fn("x"), fn("y"),
			{ID: "table:t", Kind: KindTable, External: true}},
		Edges: []Edge{
			{From: "h", To: "parse", Type: "calls", Line: 1},
			{From: "parse", To: "helper", Type: "calls", Line: 1},
			{From: "h", To: "save", Type: "calls", Line: 2},
			{From: "save", To: "helper", Type: "calls", Line: 3},
			{From: "save", To: "insert", Type: "calls", Line: 4},
			{From: "insert", To: "table:t", Type: "writes", Line: 5},
			{From: "x", To: "y", Type: "calls", Line: 1},
		},
	}
	ix := NewIndex(g)
	got := Prune(ix, ix.Tree("h", 0))
	if len(got.Children) != 1 || got.Children[0].ID != "save" || got.Support != 1 {
		t.Fatalf("h: want only save, with parse counted; got %+v", got)
	}
	if s := got.Children[0]; len(s.Children) != 1 || s.Children[0].ID != "insert" || s.Support != 1 {
		t.Errorf("save: want insert, with helper counted; got %+v", s)
	}
	if bare := Prune(ix, ix.Tree("x", 0)); len(bare.Children) != 1 || bare.Children[0].ID != "y" {
		t.Errorf("nothing leads anywhere: keep the first level; got %+v", bare)
	}
}

func TestTraceShowsProposedSketch(t *testing.T) {
	fn := func(id string) Node { return Node{ID: id, Kind: KindFunction} }
	g := &Graph{
		Nodes: []Node{fn("h"), fn("save"), {ID: "table:t", Kind: KindTable, External: true},
			{ID: "new:refund", Kind: KindFunction, Proposed: true, Fields: map[string]any{"role": RoleUtility}}},
		Edges: []Edge{
			{From: "h", To: "save", Type: Calls},
			{From: "save", To: "table:t", Type: Writes},
			// a call that leads nowhere new would be pruned; a sketched one stays
			{From: "h", To: "new:refund", Type: Calls, Proposed: true},
			{From: "new:refund", To: "table:t", Type: Writes, Proposed: true},
		},
	}
	ix := NewIndex(g)
	tr := Trace(ix, "h")
	var ids []string
	for _, c := range tr.Children {
		ids = append(ids, c.ID)
	}
	if len(ids) != 2 || ids[1] != "new:refund" {
		t.Fatalf("rows: %v", ids)
	}
	if got := ix.EffectsBeneath("new:refund"); len(got) != 0 {
		t.Errorf("a sketch's effects aren't the code's: %v", got)
	}
}
