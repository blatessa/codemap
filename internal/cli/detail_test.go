package cli

import (
	"testing"

	"github.com/blatessa/codemap/internal/graph"
)

func TestCutAndSettle(t *testing.T) {
	// a → b → c → d, and a → d: d is expanded under c first, so the row under
	// a says "see above". Cut at depth 2 drops c's row, and Settle clears it.
	g := &graph.Graph{
		Nodes: []graph.Node{{ID: "a", Kind: "function"}, {ID: "b", Kind: "function"}, {ID: "c", Kind: "function"}, {ID: "d", Kind: "function"}},
		Edges: []graph.Edge{{From: "a", To: "b", Type: "calls"}, {From: "b", To: "c", Type: "calls"}, {From: "c", To: "d", Type: "calls"}, {From: "a", To: "d", Type: "calls"}},
	}
	ix := graph.NewIndex(g)
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
