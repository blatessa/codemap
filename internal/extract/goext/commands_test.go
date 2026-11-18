package goext

import (
	"sort"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

func TestCommands(t *testing.T) {
	g, err := Extract("testdata/commands", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	got := map[string][]string{}
	usage := map[string]any{}
	for _, n := range g.Nodes {
		if n.Kind == graph.KindCommand {
			got[n.ID] = nil
			if !n.Entry || n.Module != "mod:go:commands/app" {
				t.Errorf("%s: entry %v, module %s", n.ID, n.Entry, n.Module)
			}
			usage[n.ID] = n.Fields["usage"]
		}
	}
	for _, e := range g.Edges {
		if _, ok := got[e.From]; ok && e.Type == graph.Calls {
			got[e.From] = append(got[e.From], strings.TrimPrefix(e.To, "go:commands/app."))
		}
	}
	want := map[string]string{
		// cobra: the root's name ("tool") is left out; db only groups commands
		"cmd:serve":           "runServe",
		"cmd:db migrate":      "runMigrate",
		"cmd:db migrate down": "Rollback",
		// urfave/cli: user only groups commands
		"cmd:sync":     "Sync",
		"cmd:user add": "addUser",
		// a home-made command table, including one built in a loop
		"cmd:join":         "Join",
		"cmd:server start": "startServer",
		"cmd:ready":        "SetStatus",
		"cmd:close":        "SetStatus",
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
	for id, w := range map[string]any{
		"cmd:serve": "Run the server", "cmd:sync": "Sync everything",
		"cmd:server start": "server start [--addr <host:port>]", "cmd:ready": "ready [<task>]",
		"cmd:user add": nil,
	} {
		if usage[id] != w {
			t.Errorf("%s usage %v, want %v", id, usage[id], w)
		}
	}
}
