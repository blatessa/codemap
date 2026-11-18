package graph

import (
	"reflect"
	"testing"
)

// TestTestsReaching: a test counts if it calls the code, or calls a helper
// that does; not from further away, and not through support code.
func TestTestsReaching(t *testing.T) {
	g := &Graph{}
	for i, id := range []string{"f", "h", "u", "a", "b", "user"} {
		g.Nodes = append(g.Nodes, fn("go:x."+id, "m", "m.go", i*10+1, i*10+9))
	}
	g.Nodes[2].Fields = map[string]any{"role": RoleUtility}
	g.Nodes = append(g.Nodes, Node{ID: "table:t", Kind: KindTable, Label: "t", Module: "db", External: true})
	g.Nodes = append(g.Nodes, fn("ts:c#Btn", "m", "c.tsx", 1, 9), fn("ts:c#Btn.onClick", "m", "c.tsx", 3, 5))
	for _, id := range []string{"direct", "via", "util", "far", "ofTable", "render"} {
		g.Nodes = append(g.Nodes, Node{ID: "test:" + id, Kind: KindTest, Label: id, Module: "m"})
	}
	edge := func(a, b, typ string) { g.Edges = append(g.Edges, Edge{From: a, To: b, Type: typ}) }
	edge("go:x.h", "go:x.f", Calls)
	edge("go:x.u", "go:x.f", Calls)
	edge("go:x.a", "go:x.b", Calls)
	edge("go:x.b", "go:x.f", Calls)
	edge("go:x.user", "table:t", Writes)
	edge("test:direct", "go:x.f", Calls)
	edge("test:via", "go:x.h", Calls)
	edge("test:util", "go:x.u", Calls) // through a utility
	edge("test:far", "go:x.a", Calls)  // three calls away
	edge("test:ofTable", "go:x.user", Calls)
	edge("ts:c#Btn", "ts:c#Btn.onClick", Calls) // a handler is part of its component
	edge("ts:c#Btn.onClick", "go:x.f", Calls)
	edge("test:render", "ts:c#Btn", Renders)
	ix := NewIndex(g)

	got := ix.TestsReaching("go:x.f")
	want := []TestReach{{Test: "test:direct", Direct: true}, {Test: "test:render", Via: "ts:c#Btn"}, {Test: "test:via", Via: "go:x.h"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tests of f: got %+v, want %+v", got, want)
	}
	got = ix.TestsReaching("table:t")
	want = []TestReach{{Test: "test:ofTable", Direct: true}} // calls the code that writes it
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tests of a table: got %+v, want %+v", got, want)
	}
}
