package goext

import (
	"sort"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// TestRouterWrapper: routes registered through the repo's own router type,
// which wraps chi.
func TestRouterWrapper(t *testing.T) {
	g, err := Extract("testdata/wrapped", project.Config{})
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
			got[e.From] = append(got[e.From], strings.TrimPrefix(e.To, "go:wrapped/routes."))
		}
	}
	var lines []string
	for id, to := range got {
		sort.Strings(to)
		lines = append(lines, id+" → "+strings.Join(to, " "))
	}
	sort.Strings(lines)
	want := []string{
		"route:ANY /hooks → Hook Logger",
		"route:GET / → Home Logger",
		"route:GET /api/v1/version → Version",
		"route:GET /issues/:index → Issue Logger", // a closure passed to two groups
		"route:GET /pulls/:index → Issue Logger",
		"route:GET /repos → ListRepos Logger ReqSignIn",
		"route:GET /repos/:id → Logger ReqSignIn ShowRepo",
		"route:GET /repos/:id/raw → Logger Raw ReqSignIn",
		"route:GET /repos/settings → Logger ReqSignIn Settings", // a closure called inside the group
		"route:GET /v2/ping → Logger Ping",
		"route:HEAD /repos/:id/raw → Logger Raw ReqSignIn",
		"route:POST /repos/:id → EditRepo Logger ReqSignIn",
		"route:POST /repos/new → CreateRepo Logger ReqSignIn",
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\n\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}
