package graph

import (
	"bytes"
	"strings"
	"testing"
)

func TestNormalizeRoutePath(t *testing.T) {
	cases := map[string]string{
		"/orders/{id}":          "/orders/:id",
		"/orders/{id:[0-9]+}":   "/orders/:id",
		"/orders/${order.id}":   "/orders/:param",
		"orders/:id/":           "/orders/:id",
		"/static/{path...}":     "/static/:path",
		"/orders?q=1":           "/orders",
		"/":                     "/",
		"//api//orders":         "/api/orders",
		"/orders/{id}/refund":   "/orders/:id/refund",
		"/orders/${id}/items/x": "/orders/:param/items/x",
	}
	for in, want := range cases {
		if got := NormalizeRoutePath(in); got != want {
			t.Errorf("NormalizeRoutePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRouteMatch(t *testing.T) {
	if !RouteMatch("/orders/:id", "/orders/:param") {
		t.Error("params should match each other")
	}
	if !RouteMatch("/orders/:id", "/orders/42") {
		t.Error("param should match a literal")
	}
	if RouteMatch("/orders/:id", "/orders/:id/refund") {
		t.Error("different lengths should not match")
	}
	if RouteMatch("/orders/search", "/users/search") {
		t.Error("different literals should not match")
	}
}

func TestIDs(t *testing.T) {
	if got := RouteID("post", "/orders/{id}"); got != "route:POST /orders/:id" {
		t.Error(got)
	}
	if got := TableID("public", "orders"); got != "table:orders" {
		t.Error(got)
	}
	if got := TableID("billing", "invoices"); got != "table:billing.invoices" {
		t.Error(got)
	}
	m, p, ok := SplitRouteID("route:GET /orders/:id")
	if !ok || m != "GET" || p != "/orders/:id" {
		t.Error(m, p, ok)
	}
}

func sample() *Graph {
	return &Graph{
		Modules: []Module{{ID: "mod:a", Label: "a"}, {ID: "mod:ext", Label: "ext", External: true}},
		Nodes: []Node{
			{ID: "route:POST /orders", Kind: KindRoute, Label: "/orders", Module: "mod:a", Entry: true},
			{ID: "a.Create", Kind: KindFunction, Label: "Create", Module: "mod:a"},
			{ID: "a.Place", Kind: KindFunction, Label: "Place", Module: "mod:a"},
			{ID: "ext:stripe", Kind: KindService, Label: "stripe", Module: "mod:ext", External: true},
			{ID: "route:POST /webhooks/stripe", Kind: KindRoute, Label: "/webhooks/stripe", Module: "mod:a", Entry: true},
			{ID: "a.Hook", Kind: KindFunction, Label: "Hook", Module: "mod:a"},
			{ID: "test:go:a.TestPlace", Kind: KindTest, Label: "TestPlace", Module: "mod:a"},
		},
		Edges: []Edge{
			{From: "route:POST /orders", To: "a.Create", Type: Calls},
			{From: "a.Create", To: "a.Place", Type: Calls},
			{From: "a.Place", To: "ext:stripe", Type: Calls},
			{From: "ext:stripe", To: "route:POST /webhooks/stripe", Type: Declared, Declared: true},
			{From: "route:POST /webhooks/stripe", To: "a.Hook", Type: Calls},
			{From: "test:go:a.TestPlace", To: "a.Place", Type: Calls},
		},
	}
}

func TestReachStopsAtExternal(t *testing.T) {
	ix := NewIndex(sample())
	start := "route:POST /orders"
	r := ix.Down(start, ix.StopAtExternal(start))
	if !r.Nodes["ext:stripe"] {
		t.Error("should reach the external node")
	}
	if r.Nodes["a.Hook"] {
		t.Error("should not continue through the external node")
	}
	r = ix.Down("ext:stripe", ix.StopAtExternal("ext:stripe"))
	if !r.Nodes["a.Hook"] {
		t.Error("starting at the external node should follow its edges")
	}
}

func TestTreeAndQueries(t *testing.T) {
	ix := NewIndex(sample())
	tr := ix.Tree("route:POST /orders", 0)
	if len(tr.Children) != 1 || tr.Children[0].ID != "a.Create" {
		t.Fatalf("unexpected tree root children: %+v", tr.Children)
	}
	place := tr.Children[0].Children[0]
	if place.ID != "a.Place" || len(place.Children) != 1 || place.Children[0].ID != "ext:stripe" {
		t.Fatalf("unexpected tree: %+v", place)
	}
	if len(place.Children[0].Children) != 0 {
		t.Error("external nodes should be leaves")
	}
	if got := ix.EntriesReaching("a.Place"); len(got) != 1 || got[0] != "route:POST /orders" {
		t.Errorf("EntriesReaching = %v", got)
	}
	tests := ix.TestsReaching("a.Place")
	if len(tests) != 1 || !tests[0].Direct {
		t.Errorf("TestsReaching(Place) = %+v", tests)
	}
	if got := ix.TestsReaching("a.Hook"); len(got) != 0 {
		t.Errorf("tests must not reach through external nodes: %+v", got)
	}
}

func TestMergeAndFetchResolution(t *testing.T) {
	server := &Graph{
		Modules: []Module{{ID: "mod:go:s", Label: "s"}},
		Nodes: []Node{
			{ID: "route:GET /orders/:id", Kind: KindRoute, Label: "/orders/:id", Module: "mod:go:s", Entry: true},
			{ID: "ext:stripe", Kind: KindService, Label: "stripe", Module: "mod:go:s", External: true, Fields: map[string]any{"a": 1}},
		},
	}
	web := &Graph{
		Modules: []Module{{ID: "mod:ts:web/api", Label: "web/api"}},
		Nodes: []Node{{ID: "ts:web/api/orders.ts#getOrder", Kind: KindFunction, Label: "getOrder", Module: "mod:ts:web/api"}},
		Edges: []Edge{
			{From: "ts:web/api/orders.ts#getOrder", To: "route:GET /orders/:param", Type: Fetches},
			{From: "ts:web/api/orders.ts#getOrder", To: "route:DELETE /nowhere", Type: Fetches},
		},
	}
	declared := &Graph{Nodes: []Node{{ID: "ext:stripe", Fields: map[string]any{"owner": "Payments"}}}}

	g := Merge(server, web, declared)
	ix := NewIndex(g)
	if out := ix.Out["ts:web/api/orders.ts#getOrder"]; len(out) != 2 {
		t.Fatalf("want 2 fetch edges, got %d", len(out))
	}
	found := false
	for _, e := range ix.Out["ts:web/api/orders.ts#getOrder"] {
		if e.To == "route:GET /orders/:id" {
			found = true
		}
	}
	if !found {
		t.Error("fetch should resolve to the server route")
	}
	if n := ix.Node["route:DELETE /nowhere"]; n == nil || n.Fields["unmatched"] != true {
		t.Error("unmatched fetch should create a placeholder route")
	}
	s := ix.Node["ext:stripe"]
	if s.Fields["owner"] != "Payments" || s.Fields["a"] != 1 || s.Kind != KindService {
		t.Errorf("fields should merge: %+v", s)
	}
	if errs := Validate(g); len(errs) > 0 {
		t.Errorf("merged graph invalid: %v", errs)
	}
}

func TestEncodeIsStable(t *testing.T) {
	g := sample()
	var a, b bytes.Buffer
	if err := g.Encode(&a); err != nil {
		t.Fatal(err)
	}
	g.Nodes[0], g.Nodes[1] = g.Nodes[1], g.Nodes[0]
	if err := g.Encode(&b); err != nil {
		t.Fatal(err)
	}
	if a.String() != b.String() {
		t.Error("encoding should not depend on input order")
	}
	back, err := Decode(strings.NewReader(a.String()))
	if err != nil || len(back.Nodes) != len(g.Nodes) {
		t.Fatal(err)
	}
}
