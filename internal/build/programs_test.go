package build

import (
	"errors"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
)

func TestPrograms(t *testing.T) {
	files := map[string]string{
		"go.mod":                 "module github.com/acme/shop\n\ngo 1.22\n",
		"web/package.json":       `{"name": "@acme/storefront"}`,
		"tools/gen/package.json": `{"private": true}`,
		"a/svc/Cargo.toml":       "[package]\nname = \"svc\"\n",
		"b/svc/Cargo.toml":       "[package]\nname = \"svc\"\n",
	}
	read := func(f string) ([]byte, error) {
		if s, ok := files[f]; ok {
			return []byte(s), nil
		}
		return nil, errors.New("no file")
	}
	g := &graph.Graph{Modules: []graph.Module{
		{ID: "server", Path: "internal/orders"},
		{ID: "web", Path: "web/src/pages"},
		{ID: "gen", Path: "tools/gen/src"},
		{ID: "svc-a", Path: "a/svc/src"},
		{ID: "svc-b", Path: "b/svc/src"},
		{ID: "db", Path: "db/migrations", External: true},
	}}
	Programs(g, read)
	want := map[string]string{
		"server": "shop",       // the Go module's last element
		"web":    "storefront", // package.json's name, without its scope
		"gen":    "gen",        // no name: the folder
		"svc-a":  "a/svc",      // same name twice: the folders
		"svc-b":  "b/svc",
		"db":     "", // outside the code
	}
	for _, m := range g.Modules {
		if m.Program != want[m.ID] {
			t.Errorf("%s: program %q, want %q", m.ID, m.Program, want[m.ID])
		}
	}
}
