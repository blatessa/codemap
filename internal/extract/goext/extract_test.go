package goext

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codemap/internal/graph"
	"codemap/internal/project"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden.json")

const shopRoot = "../../../testdata/shop"

func extractShop(t *testing.T) *graph.Graph {
	t.Helper()
	proj, err := project.Load(shopRoot)
	if err != nil {
		t.Fatal(err)
	}
	g, err := Extract(shopRoot, proj.Config)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Errorf("invalid graph: %v", e)
	}
	return g
}

// goSide reports whether an expected-graph ID is produced by the Go side
// (everything but the TypeScript extractor's nodes).
func goSide(id string) bool {
	for _, p := range []string{"ts:", "page:", "test:ts:"} {
		if strings.HasPrefix(id, p) {
			return false
		}
	}
	return true
}

// codeFields are the node fields the Go extractor produces. Others in the
// expected graph (owner, links, …) come from .codemap/external.yaml.
var codeFields = []string{"method", "columns", "source", "message", "import", "every"}

func jsonEq(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

// TestShopExpected checks that every Go-side node and edge of the hand-written
// expected graph is extracted. Extra nodes and edges are reported, not failed.
func TestShopExpected(t *testing.T) {
	g := extractShop(t)
	f, err := os.Open("../../../testdata/shop.expected.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	want, err := graph.Decode(f)
	if err != nil {
		t.Fatal(err)
	}

	gotMods := map[string]graph.Module{}
	for _, m := range g.Modules {
		gotMods[m.ID] = m
	}
	for _, m := range want.Modules {
		if !strings.HasPrefix(m.ID, "mod:go:") && !strings.HasPrefix(m.ID, "mod:sql:") && !strings.HasPrefix(m.ID, "mod:queue:") && !strings.HasPrefix(m.ID, "mod:ext:") {
			continue
		}
		got, ok := gotMods[m.ID]
		if !ok {
			t.Errorf("missing module %s", m.ID)
			continue
		}
		if got != m {
			t.Errorf("module %s:\n got %+v\nwant %+v", m.ID, got, m)
		}
	}

	gotNodes := map[string]graph.Node{}
	for _, n := range g.Nodes {
		gotNodes[n.ID] = n
	}
	wantNodes := map[string]bool{}
	for _, w := range want.Nodes {
		if !goSide(w.ID) {
			continue
		}
		wantNodes[w.ID] = true
		n, ok := gotNodes[w.ID]
		if !ok {
			t.Errorf("missing node %s", w.ID)
			continue
		}
		check := func(what string, got, want any) {
			if got != want {
				t.Errorf("node %s: %s = %v, want %v", w.ID, what, got, want)
			}
		}
		check("kind", n.Kind, w.Kind)
		check("label", n.Label, w.Label)
		check("module", n.Module, w.Module)
		check("file", n.File, w.File)
		check("line", n.Line, w.Line)
		check("doc", n.Doc, w.Doc)
		check("entry", n.Entry, w.Entry)
		check("external", n.External, w.External)
		if w.EndLine != 0 && n.EndLine != w.EndLine {
			// Some endLines in the hand-written graph are approximate.
			t.Logf("node %s: endLine = %d, expected graph says %d", w.ID, n.EndLine, w.EndLine)
		}
		for _, k := range codeFields {
			if wv, ok := w.Fields[k]; ok && !jsonEq(n.Fields[k], wv) {
				t.Errorf("node %s: fields.%s =\n %v\nwant\n %v", w.ID, k, n.Fields[k], wv)
			}
		}
	}

	type key struct{ from, to, typ string }
	gotEdges := map[key]graph.Edge{}
	for _, e := range g.Edges {
		gotEdges[key{e.From, e.To, e.Type}] = e
	}
	wantEdges := map[key]bool{}
	for _, w := range want.Edges {
		if !goSide(w.From) || !goSide(w.To) || w.Declared {
			continue
		}
		k := key{w.From, w.To, w.Type}
		wantEdges[k] = true
		e, ok := gotEdges[k]
		if !ok {
			t.Errorf("missing edge %s -> %s (%s)", w.From, w.To, w.Type)
			continue
		}
		if w.Detail != "" && e.Detail != w.Detail {
			t.Errorf("edge %s -> %s: detail = %q, want %q", w.From, w.To, e.Detail, w.Detail)
		}
	}

	for _, n := range g.Nodes {
		if !wantNodes[n.ID] {
			t.Logf("extra node %s", n.ID)
		}
	}
	for k := range gotEdges {
		if !wantEdges[k] {
			t.Logf("extra edge %s -> %s (%s)", k.from, k.to, k.typ)
		}
	}
}

func TestShopGolden(t *testing.T) {
	g := extractShop(t)
	var buf bytes.Buffer
	if err := g.Encode(&buf); err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "shop.golden.json")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("%v (run go test -update to create it)", err)
	}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Errorf("graph differs from %s; run go test ./internal/extract/goext -update and review the diff", golden)
	}
}
