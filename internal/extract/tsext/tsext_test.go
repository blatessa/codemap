package tsext

import (
	"bytes"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

var update = flag.Bool("update", false, "rewrite testdata/shop.golden.json")

const shop = "../../../testdata/shop"

func needNode(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not installed")
	}
}

func extractShop(t *testing.T) *graph.Graph {
	t.Helper()
	needNode(t)
	proj, err := project.Load(shop)
	if err != nil {
		t.Fatal(err)
	}
	g, err := Extract(shop, proj.Config)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func isTS(id string) bool {
	return strings.HasPrefix(id, "ts:") || strings.HasPrefix(id, "page:") || strings.HasPrefix(id, "test:ts:")
}

// The extracted graph, merged with the Go side of the hand-written expected graph,
// must contain every TS node and every edge touching one. Extras are logged.
func TestShopMatchesExpected(t *testing.T) {
	got := extractShop(t)

	f, err := os.Open("../../../testdata/shop.expected.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	want, err := graph.Decode(f)
	if err != nil {
		t.Fatal(err)
	}

	goSide := &graph.Graph{Version: graph.Version}
	for _, m := range want.Modules {
		if !strings.HasPrefix(m.ID, "mod:ts:") {
			goSide.Modules = append(goSide.Modules, m)
		}
	}
	for _, n := range want.Nodes {
		if !isTS(n.ID) {
			goSide.Nodes = append(goSide.Nodes, n)
		}
	}
	for _, e := range want.Edges {
		if !isTS(e.From) && !isTS(e.To) {
			goSide.Edges = append(goSide.Edges, e)
		}
	}
	merged := graph.Merge(goSide, got)
	for _, err := range graph.Validate(merged) {
		t.Error(err)
	}

	mods := map[string]graph.Module{}
	for _, m := range merged.Modules {
		mods[m.ID] = m
	}
	for _, m := range want.Modules {
		if _, ok := mods[m.ID]; !ok {
			t.Errorf("missing module %s", m.ID)
		}
	}

	nodes := map[string]graph.Node{}
	for _, n := range merged.Nodes {
		nodes[n.ID] = n
	}
	wantNodes := map[string]bool{}
	for _, w := range want.Nodes {
		if !isTS(w.ID) {
			continue
		}
		wantNodes[w.ID] = true
		g, ok := nodes[w.ID]
		if !ok {
			t.Errorf("missing node %s", w.ID)
			continue
		}
		if g.Kind != w.Kind || g.Label != w.Label || g.Module != w.Module || g.File != w.File ||
			g.Line != w.Line || g.EndLine != w.EndLine || g.Doc != w.Doc || g.Entry != w.Entry {
			t.Errorf("node %s:\n got  %+v\n want %+v", w.ID, g, w)
		}
	}
	for _, n := range got.Nodes {
		if !wantNodes[n.ID] {
			t.Logf("extra node %s", n.ID)
		}
	}

	type key struct{ from, to, typ string }
	edges := map[key]bool{}
	for _, e := range merged.Edges {
		edges[key{e.From, e.To, e.Type}] = true
	}
	wantEdges := map[key]bool{}
	for _, e := range want.Edges {
		if !isTS(e.From) && !isTS(e.To) {
			continue
		}
		k := key{e.From, e.To, e.Type}
		wantEdges[k] = true
		if !edges[k] {
			t.Errorf("missing edge %s -> %s (%s)", e.From, e.To, e.Type)
		}
	}
	for _, e := range merged.Edges {
		if (isTS(e.From) || isTS(e.To)) && !wantEdges[key{e.From, e.To, e.Type}] {
			t.Logf("extra edge %s -> %s (%s)", e.From, e.To, e.Type)
		}
	}

	// The traces the plan calls out.
	ix := graph.NewIndex(merged)
	down := ix.Down("ts:web/src/components/PlaceOrderButton.tsx#PlaceOrderButton.onClick", nil)
	for _, id := range []string{"ts:web/src/api/orders.ts#createOrder", "route:POST /orders"} {
		if !down.Nodes[id] {
			t.Errorf("PlaceOrderButton.onClick should reach %s", id)
		}
	}
	if !edges[key{"ts:web/src/api/orders.ts#getOrder", "route:GET /orders/:id", graph.Fetches}] {
		t.Error("getOrder should fetch route:GET /orders/:id after merge")
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
		t.Fatalf("%v (run go test ./internal/extract/tsext -update)", err)
	}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Errorf("output differs from %s; run with -update and review the diff:\n%s", golden, buf.String())
	}
}

func captureWarnings(t *testing.T) *[]string {
	var ws []string
	old := Warn
	Warn = func(s string) { ws = append(ws, s) }
	t.Cleanup(func() { Warn = old })
	return &ws
}

func TestNoRoots(t *testing.T) {
	ws := captureWarnings(t)
	g, err := Extract(t.TempDir(), project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Nodes) != 0 || len(*ws) != 1 || !strings.Contains((*ws)[0], "no TypeScript roots") {
		t.Errorf("want empty graph and a warning, got %d nodes, warnings %q", len(g.Nodes), *ws)
	}
}

func TestNoNode(t *testing.T) {
	ws := captureWarnings(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tsconfig.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "")
	g, err := Extract(dir, project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Nodes) != 0 || len(*ws) != 1 || !strings.Contains((*ws)[0], "node is not installed") {
		t.Errorf("want empty graph and a warning, got %d nodes, warnings %q", len(g.Nodes), *ws)
	}
}
