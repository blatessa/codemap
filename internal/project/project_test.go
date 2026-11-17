package project

import (
	"testing"
	"testing/fstest"

	"codemap/internal/graph"
)

func TestLoadFSAndProposals(t *testing.T) {
	fsys := fstest.MapFS{
		"areas.yaml":  {Data: []byte("- name: Commerce\n  modules: [mod:go:shop/internal/orders]\n")},
		"layout.json": {Data: []byte(`{"mod:go:shop/internal/orders":[1200,80]}`)},
		"external.yaml": {Data: []byte(`nodes:
  - id: ext:stripe
    owner: Payments team
    links:
      - {label: Dashboard, url: https://dashboard.stripe.com}
  - id: ext:s3-uploads
    kind: bucket
    region: us-east-1
edges:
  - {from: ext:stripe, to: "route:POST /webhooks/stripe", detail: sends events}
`)},
		"proposals/refunds.md": {Data: []byte("---\nname: Refunds\nstatus: open\nnodes:\n  - {id: new:x, kind: function, label: X}\n---\n## Why\nBecause.\n")},
		"proposals/loose.md":   {Data: []byte("# Loose idea\n\nNo frontmatter.\n")},
	}
	p, err := LoadFS(fsys)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Areas) != 1 || p.Areas[0].Name != "Commerce" {
		t.Errorf("areas: %+v", p.Areas)
	}
	if p.Layout["mod:go:shop/internal/orders"] != [2]float64{1200, 80} {
		t.Errorf("layout: %+v", p.Layout)
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
	if err != nil || again.Name != "Refunds" || again.Body != ref.Body {
		t.Errorf("round trip: %v %+v", err, again)
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
	if len(p.Areas) != 5 || len(p.Proposals) != 2 || len(p.External.Nodes) != 2 || len(p.Config.Go.Jobs) != 1 {
		t.Errorf("unexpected fixture project: areas=%d proposals=%d external=%d jobs=%d",
			len(p.Areas), len(p.Proposals), len(p.External.Nodes), len(p.Config.Go.Jobs))
	}
	if p.Proposals[0].Slug != "order-search" || p.Proposals[0].Status != "archived" || p.Proposals[1].Name != "Refunds" {
		t.Errorf("proposals: %+v %+v", p.Proposals[0], p.Proposals[1])
	}
}
