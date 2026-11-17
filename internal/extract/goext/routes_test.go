package goext

import (
	"sort"
	"strings"
	"testing"

	"codemap/internal/graph"
	"codemap/internal/project"
)

func TestRouters(t *testing.T) {
	g, err := Extract("testdata/routers", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	got := map[string][]string{}
	for _, n := range g.Nodes {
		if n.Kind == graph.KindRoute {
			got[n.ID] = nil
		}
	}
	for _, e := range g.Edges {
		if _, ok := got[e.From]; ok {
			got[e.From] = append(got[e.From], strings.TrimPrefix(e.To, "go:routers/app."))
		}
	}
	want := map[string]string{
		// chi
		"route:GET /health":             "(*Handlers).Health Logger",
		"route:GET /orders":             "(*Handlers).ListOrders Auth Logger",
		"route:POST /orders/:id/refund": "(*Handlers).Refund Audit Auth Logger",
		"route:GET /orders/:id/items":   "(*Handlers).Items Auth Logger",
		"route:DELETE /admin/users/:id": "(*Handlers).DeleteUser Admin Logger",
		"route:GET /api/v1/ping":        "(*Handlers).Ping Logger",
		"route:GET /inline":             "(*Handlers).Helper Logger",
		// gin
		"route:GET /api/v2/users/:id": "(*Handlers).GinUser GinAuth GinRate",
		"route:POST /api/v2/users":    "(*Handlers).GinCreate GinAuth",
		"route:PUT /things/:id":       "(*Handlers).GinThing",
		"route:GET /late":             "(*Handlers).GinThing GinLate",
		// echo
		"route:GET /admin/stats": "(*Handlers).EchoStats EchoAuth EchoCache EchoLate EchoLog",
		"route:GET /search":      "(*Handlers).EchoSearch EchoLate EchoLog",
		"route:POST /search":     "(*Handlers).EchoSearch EchoLate EchoLog",
		// gorilla/mux
		"route:GET /products/:id": "(*Handlers).Product MuxLog",
		"route:PUT /products/:id": "(*Handlers).Product MuxLog",
		"route:POST /v3/carts":    "(*Handlers).Carts MuxLog",
		"route:GET /legacy":       "(*Handlers).Legacy MuxLog",
		// net/http
		"route:GET /files/:path": "(*Handlers).Files",
		"route:POST /hooks":      "(*Handlers).Hook withAuth",
		"route:ANY /default":     "(*Handlers).Default",
	}
	for id, w := range want {
		edges, ok := got[id]
		if !ok {
			t.Errorf("missing %s", id)
			continue
		}
		sort.Strings(edges)
		if s := strings.Join(edges, " "); s != w {
			t.Errorf("%s calls %q, want %q", id, s, w)
		}
	}
	for id := range got {
		if _, ok := want[id]; !ok {
			t.Errorf("unexpected %s", id)
		}
	}
}

func TestSplitServeMuxPattern(t *testing.T) {
	cases := map[string]string{
		"GET /orders/{id}":           "GET /orders/{id}",
		"/static/":                   "ANY /static/",
		"POST example.com/hooks/{$}": "POST /hooks/",
		"example.com/":               "ANY /",
		"DELETE  /x":                 "DELETE /x",
	}
	for in, want := range cases {
		m, p := splitServeMuxPattern(in)
		if got := m + " " + p; got != want {
			t.Errorf("splitServeMuxPattern(%q) = %q, want %q", in, got, want)
		}
	}
}
