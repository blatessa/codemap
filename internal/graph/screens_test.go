package graph

import (
	"reflect"
	"testing"
)

// TestScreenEffects: rendering a screen is an effect, rendering a component
// isn't, and a screen rendered by shared code (an error page) isn't one of
// its callers' effects.
func TestScreenEffects(t *testing.T) {
	g := &Graph{}
	for i, id := range []string{"handler", "fail"} {
		g.Nodes = append(g.Nodes, fn("go:x."+id, "m", "m.go", i*10+1, i*10+9))
	}
	g.Nodes[1].Fields = map[string]any{"shared": true}
	g.Nodes = append(g.Nodes, fn("ts:c#Page", "m", "c.tsx", 1, 9), fn("ts:c#Btn", "m", "c.tsx", 11, 19))
	for _, s := range []string{"list", "500", "header"} {
		g.Nodes = append(g.Nodes, Node{ID: ScreenID(s), Kind: KindScreen, Label: s, Module: "mod:tmpl:templates", External: true})
	}
	g.Nodes = append(g.Nodes, Node{ID: "table:t", Kind: KindTable, Label: "t", Module: "db", External: true})
	edge := func(a, b, typ string) { g.Edges = append(g.Edges, Edge{From: a, To: b, Type: typ}) }
	edge("go:x.handler", ScreenID("list"), Renders)
	edge("go:x.handler", "go:x.fail", Calls)
	edge("go:x.fail", ScreenID("500"), Renders)
	edge("go:x.fail", "table:t", Writes)
	edge(ScreenID("list"), ScreenID("header"), Renders)
	edge("ts:c#Page", "ts:c#Btn", Renders)
	ix := NewIndex(g)

	got := ix.EffectsBeneath("go:x.handler")
	want := []Effect{{To: ScreenID("list"), Type: Renders}, {To: "table:t", Type: Writes}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("effects of handler: got %+v, want %+v", got, want)
	}
	if got := ix.EffectsBeneath("ts:c#Page"); len(got) != 0 {
		t.Errorf("rendering a component is no effect: %+v", got)
	}
	for _, c := range ix.Tree("go:x.handler", 0).Children {
		if c.ID == ScreenID("list") && len(c.Children) != 0 {
			t.Errorf("a screen is a leaf: %+v", c)
		}
	}
}
