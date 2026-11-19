package goext

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

func extractBackground(t *testing.T) *graph.Graph {
	t.Helper()
	g, err := Extract("testdata/background", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	return g
}

func short(id string) string { return strings.TrimPrefix(id, "go:background/") }

func checkLines(t *testing.T, got, want []string) {
	t.Helper()
	sort.Strings(got)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\n\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// TestOutboundHTTP: requests to URLs known only at run time become calls to
// ext:http:<package> from the function deciding the URL; constant hosts and
// the repo's own routes keep their edges.
func TestOutboundHTTP(t *testing.T) {
	g := extractBackground(t)
	var got []string
	for _, e := range g.Edges {
		if e.Type == graph.Fetches || e.Type == graph.Calls && strings.HasPrefix(e.To, "ext:") {
			got = append(got, short(e.From)+" -> "+e.To+" ["+e.Detail+"]")
		}
	}
	checkLines(t, got, []string{
		"fetch.Ping -> ext:status.example.com [GET /ping]",              // constant URL, as before
		"fetch.Probe -> ext:http:background/fetch [HEAD {}]",            // no repo caller: its own
		"fetch.Refresh -> ext:http:background/fetch [GET {}]",           // through Download and get
		"fetch.Version -> ext:api.example.com [GET /v1/version]",        // a constant host through helpers
		"notify.(*Client).Send -> ext:http:background/notify [POST {}]", // the client is kept in a variable
		"notify.Chat -> ext:http:background/notify [PUT {}]",            // a builder in one expression
		"notify.Hook -> ext:http:background/notify [GET {}]",            // the builder's default method
		"notify.Items -> route:GET /api/items [GET /api/items]",         // the repo's own API
	})
	for _, n := range g.Nodes {
		if n.ID == "ext:http:background/fetch" {
			if n.Label != "HTTP · fetch" || n.Module != servicesModule || !n.External || n.Fields["via"] != "background/fetch" {
				t.Errorf("node %+v", n)
			}
		}
	}
}

// TestBackgroundJobs: loops started from main on a timer or over a channel
// are jobs; one-shot goroutines, per-request and per-connection ones and a
// scheduling helper's own goroutine are not.
func TestBackgroundJobs(t *testing.T) {
	g := extractBackground(t)
	var got []string
	for _, n := range g.Nodes {
		if n.Kind != graph.KindJob {
			continue
		}
		var to []string
		for _, e := range g.Edges {
			if e.From == n.ID {
				to = append(to, short(e.To))
			}
		}
		sort.Strings(to)
		got = append(got, fmt.Sprintf("%s %v entry=%v %s:%d -> %s", n.ID, n.Fields, n.Entry, n.File, n.Line, strings.Join(to, ", ")))
	}
	checkLines(t, got, []string{
		"job:cleanupScheduler map[every:d] entry=true cmd/app/main.go:22 -> cmd/app.cleanupScheduler",
		"job:main map[every:5 * time.Minute] entry=true cmd/app/main.go:23 -> cmd/app.refreshAll",
		"job:poll map[every:30 * time.Second] entry=true cmd/app/main.go:29 -> cmd/app.poll",
		"job:warmCache map[after:10*time.Second] entry=true cmd/app/main.go:30 -> cmd/app.warmCache",
		"job:worker map[] entry=true cmd/app/main.go:20 -> cmd/app.worker",
	})
}

// TestPackageVars: calls made initialising package-level variables belong to
// the package's init node, which counts as reached when its package is; a
// variable storing function literals is a node the init calls (the call
// graph doesn't see Run calling through the map).
func TestPackageVars(t *testing.T) {
	g := extractBackground(t)
	var got []string
	for _, e := range g.Edges {
		if strings.HasPrefix(e.From, "go:background/rules.") && e.Type == graph.Calls {
			got = append(got, short(e.From)+" -> "+short(e.To))
		}
	}
	checkLines(t, got, []string{
		"rules.handlers -> rules.doA",
		"rules.init -> rules.build",
		"rules.init -> rules.handlers",
	})
	read := func(f string) ([]byte, error) { return os.ReadFile(filepath.Join("testdata/background", f)) }
	graph.AssignRoles(g, read)
	for _, n := range g.Nodes {
		switch n.ID {
		case "go:background/rules.init":
			if n.Label != "init (package vars)" || n.Fields["role"] != graph.RoleWiring || n.Entry {
				t.Errorf("init node %+v", n)
			}
		case "go:background/rules.build", "go:background/rules.doA", "go:background/rules.handlers":
			if n.Fields["role"] == graph.RoleUnreachable {
				t.Errorf("%s is unreachable", n.ID)
			}
		}
	}
}
