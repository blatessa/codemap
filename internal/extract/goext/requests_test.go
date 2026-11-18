package goext

import (
	"sort"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// TestRequests: a client calling the repo's own API through request helpers
// gets fetches edges to the routes it reaches.
func TestRequests(t *testing.T) {
	g, err := Extract("testdata/requests", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	var got []string
	for _, e := range g.Edges {
		if e.Type == graph.Fetches || e.Type == graph.Calls && strings.HasPrefix(e.To, "ext:") {
			got = append(got, strings.TrimPrefix(e.From, "go:requests/client.")+" -> "+e.To+" ["+e.Detail+"] "+e.File)
		}
	}
	sort.Strings(got)
	want := []string{
		"(*Client).Approve -> route:POST /:tenant/api/tasks/:id/approve [POST /tasks/{}/approve] client/client.go",
		"(*Client).CreateTask -> route:POST /:tenant/api/tasks [POST /tasks] client/client.go",
		"(*Client).Health -> route:ANY /healthz [GET /healthz] client/client.go", // url.Parse, then (*http.Client).Get
		"(*Client).Me -> route:GET /:tenant/api/users/me [GET /users/me] client/client.go",
		"(*Client).SetStatus -> route:POST /:tenant/api/tasks/:id/:action [POST /tasks/{}/{}] client/client.go",
		"(*Client).Task -> route:GET /:tenant/api/tasks/:id [GET /tasks/{}] client/client.go",
		"(*Client).Tasks -> route:GET /:tenant/api/tasks [GET /tasks{}] client/client.go", // a query string appended
		"(*Client).User -> route:GET /:tenant/api/users/:name [GET /users/{}] client/client.go",
		"(*Client).Users -> route:GET /:tenant/api/users [GET /users] client/client.go", // through a path builder
		"Weather -> ext:api.weather.example [GET /v1/today] client/client.go",
		// not Missing (DELETE /tasks: no such route), Wrong (PUT /users/me)
		// nor ProjectTasks (/projects/{}/tasks agrees with no route on two segments)
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\n\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
