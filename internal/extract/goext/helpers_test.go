package goext

import (
	"sort"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// TestRouteHelpers: routes registered through closures and functions whose
// paths are built from their parameters, and through a table of routes.
func TestRouteHelpers(t *testing.T) {
	g, err := Extract("testdata/helpers", project.Config{})
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
			got[e.From] = append(got[e.From], strings.TrimPrefix(e.To, "go:helpers."))
		}
	}
	var lines []string
	for id, to := range got {
		sort.Strings(to)
		lines = append(lines, id+" → "+strings.Join(to, " "))
	}
	sort.Strings(lines)
	want := []string{
		// strings.Cut, a prefix, and the handler bound to the call site's argument
		"route:GET /:org/api/state → (*Org).State (*Server).org (*Server).wrap",
		"route:GET /api/v2/reports → (*Server).Report", // fmt.Sprintf
		"route:GET /shop/items → (*Server).Items",      // path.Join
		"route:GET /svc/health → (*Server).Health",     // strings.TrimSuffix, a local
		"route:GET /table/a → (*Server).A",
		"route:GET /table/b → (*Server).B",
		"route:GET /v1/users → (*Server).Users",
		"route:POST /:org/api/tasks → (*Org).CreateTask (*Server).org (*Server).wrap",
		"route:POST /:org/api/tasks/:id/close → (*Org).SetStatus (*Server).org (*Server).wrap",
		"route:POST /:org/api/tasks/:id/ready → (*Org).SetStatus (*Server).org (*Server).wrap",
		"route:POST /:org/api/tasks/:id/share → (*Server).Share (*Server).org (*Server).wrap",
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\n\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}
