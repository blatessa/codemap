package project

import (
	"reflect"
	"testing"
	"testing/fstest"

	"github.com/blatessa/codemap/internal/graph"
)

func TestLoadFSAndProposals(t *testing.T) {
	fsys := fstest.MapFS{
		"external.toml": {Data: []byte(`[[node]]
id = "ext:stripe"
owner = "Payments team"
links = [{label = "Dashboard", url = "https://dashboard.stripe.com"}]

[[node]]
id = "ext:s3-uploads"
kind = "bucket"
region = "us-east-1"

[[edge]]
from = "ext:stripe"
to = "route:POST /webhooks/stripe"
detail = "sends events"
`)},
		"proposals/refunds.md": {Data: []byte("+++\nname = \"Refunds\"\nstatus = \"open\"\n\n[[node]]\nid = \"new:x\"\nkind = \"function\"\nlabel = \"X\"\n+++\n## Why\nBecause.\n")},
		"proposals/loose.md":   {Data: []byte("# Loose idea\n\nNo frontmatter.\n")},
	}
	p, err := LoadFS(fsys)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Proposals) != 2 {
		t.Fatalf("proposals: %d", len(p.Proposals))
	}
	loose, ref := p.Proposals[0], p.Proposals[1]
	if loose.Name != "Loose idea" || loose.Status != "open" {
		t.Errorf("loose: %+v", loose)
	}
	if ref.Slug != "refunds" || ref.Body != "## Why\nBecause.\n" || len(ref.Nodes) != 1 {
		t.Errorf("refunds: %+v", ref)
	}
	out, err := ref.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	again, err := ParseProposal(out)
	if err != nil || again.Name != "Refunds" || again.Body != ref.Body || !reflect.DeepEqual(again.Nodes, ref.Nodes) {
		t.Errorf("round trip: %v %+v", err, again)
	}
	if out2, _ := again.Marshal(); string(out2) != string(out) {
		t.Errorf("round trip is not stable:\n%s\n---\n%s", out, out2)
	}

	decl := p.External.ToGraph()
	extracted := &graph.Graph{
		Modules: []graph.Module{{ID: "mod:ext", Label: "ext", External: true}, {ID: "mod:s", Label: "s"}},
		Nodes: []graph.Node{
			{ID: "ext:stripe", Kind: "service", Label: "stripe", Module: "mod:ext", External: true},
			{ID: "route:POST /webhooks/stripe", Kind: "route", Label: "/webhooks/stripe", Module: "mod:s", Entry: true},
		},
	}
	FillDeclaredDefaults(decl, extracted)
	g := graph.Merge(extracted, decl)
	if errs := graph.Validate(g); len(errs) > 0 {
		t.Fatalf("invalid: %v", errs)
	}
	ix := graph.NewIndex(g)
	if ix.Node["ext:stripe"].Fields["owner"] != "Payments team" {
		t.Error("declared fields should merge into the extracted node")
	}
	if b := ix.Node["ext:s3-uploads"]; b == nil || b.Kind != "bucket" || b.Fields["region"] != "us-east-1" || !b.External {
		t.Errorf("declared node: %+v", b)
	}
	if e := ix.Out["ext:stripe"]; len(e) != 1 || !e[0].Declared || e[0].Type != graph.Declared {
		t.Errorf("declared edge: %+v", e)
	}
}

func TestBlockFor(t *testing.T) {
	blocks := []Block{
		{ID: "block:checkout", From: "mod:ts:web/src/pages", Match: []string{"/checkout*", "/orders/*"}},
		{ID: "block:account", From: "mod:ts:web/src/pages", Files: []string{"web/src/pages/account/**"}},
	}
	cases := []struct {
		n    graph.Node
		want string
	}{
		{graph.Node{Module: "mod:ts:web/src/pages", Label: "/checkout"}, "block:checkout"},
		{graph.Node{Module: "mod:ts:web/src/pages", Label: "/orders/:id"}, "block:checkout"},
		{graph.Node{Module: "mod:ts:web/src/pages", Label: "/settings", File: "web/src/pages/account/deep/Settings.tsx"}, "block:account"},
		{graph.Node{Module: "mod:ts:web/src/pages", Label: "/login", File: "web/src/pages/LoginPage.tsx"}, ""},
		{graph.Node{Module: "mod:other", Label: "/checkout"}, ""},
	}
	for _, c := range cases {
		if got := BlockFor(blocks, c.n); got != c.want {
			t.Errorf("BlockFor(%+v) = %q, want %q", c.n, got, c.want)
		}
	}
}

func TestSlugify(t *testing.T) {
	if s := Slugify("Stock reservation via events!"); s != "stock-reservation-via-events" {
		t.Error(s)
	}
}

func TestLoadFixture(t *testing.T) {
	p, err := Load("../../testdata/shop")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Proposals) != 2 || len(p.External.Nodes) != 2 || len(p.Config.Go.Jobs) != 1 {
		t.Errorf("unexpected fixture project: proposals=%d external=%d jobs=%d",
			len(p.Proposals), len(p.External.Nodes), len(p.Config.Go.Jobs))
	}
	if p.Proposals[0].Slug != "order-search" || p.Proposals[0].Status != "archived" || p.Proposals[1].Name != "Refunds" {
		t.Errorf("proposals: %+v %+v", p.Proposals[0], p.Proposals[1])
	}
}

func TestMarshalRoundTrip(t *testing.T) {
	ext := External{
		Nodes: []map[string]any{{
			"owner": "Payments", "id": "ext:stripe", "rate": 100.0, "ratio": 0.5, "zzz": nil,
			"links": []any{map[string]any{"url": "https://x", "label": "Docs"}},
			"meta":  map[string]any{"b": "2", "a": true},
		}},
		Edges: []ExternalEdge{{From: "ext:stripe", To: "x"}},
	}
	b, err := MarshalTOML(ext)
	if err != nil {
		t.Fatal(err)
	}
	want := `[[node]]
id = 'ext:stripe'
links = [{label = 'Docs', url = 'https://x'}]
meta = {a = true, b = '2'}
owner = 'Payments'
rate = 100
ratio = 0.5

[[edge]]
from = 'ext:stripe'
to = 'x'
`
	if string(b) != want {
		t.Errorf("got\n%s", b)
	}
	var back External
	if err := UnmarshalTOML(b, &back); err != nil {
		t.Fatal(err)
	}
	b2, _ := MarshalTOML(back)
	if string(b2) != string(b) {
		t.Errorf("not stable:\n%s", b2)
	}

	blocks := []Block{{ID: "block:a", Name: "A", From: "mod:a", Match: []string{"A*"}}}
	b, _ = MarshalList(BlockKey, blocks)
	var got []Block
	if want := "[[block]]\nid = 'block:a'\nname = 'A'\nfrom = 'mod:a'\nmatch = ['A*']\n"; string(b) != want {
		t.Errorf("blocks file:\n%s", b)
	}
	if err := UnmarshalList(BlockKey, b, &got); err != nil || !reflect.DeepEqual(got, blocks) {
		t.Errorf("blocks: %v %+v\n%s", err, got, b)
	}
	if err := UnmarshalList(BlockKey, []byte("[[blocks]]\nname = 'x'\n"), &got); err == nil {
		t.Error("want an error for the wrong table key")
	}
}
