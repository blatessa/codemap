package project

import (
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

func TestLoadFSAndProposals(t *testing.T) {
	fsys := fstest.MapFS{
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
	if len(p.Proposals) != 2 || len(p.Config.Go.Jobs) != 1 {
		t.Errorf("unexpected fixture project: proposals=%d jobs=%d", len(p.Proposals), len(p.Config.Go.Jobs))
	}
	if p.Proposals[0].Slug != "order-search" || p.Proposals[0].Status != "archived" || p.Proposals[1].Name != "Refunds" {
		t.Errorf("proposals: %+v %+v", p.Proposals[0], p.Proposals[1])
	}
}

func TestMarshalRoundTrip(t *testing.T) {
	// free-form maps, as in a proposal's sketch
	type sketch struct {
		Nodes []map[string]any `toml:"node,omitempty"`
		Edges []map[string]any `toml:"edge,omitempty"`
	}
	ext := sketch{
		Nodes: []map[string]any{{
			"owner": "Payments", "id": "ext:stripe", "rate": 100.0, "ratio": 0.5, "zzz": nil,
			"links": []any{map[string]any{"url": "https://x", "label": "Docs"}},
			"meta":  map[string]any{"b": "2", "a": true},
		}},
		Edges: []map[string]any{{"to": "x", "from": "ext:stripe"}},
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
	var back sketch
	if err := UnmarshalTOML(b, &back); err != nil {
		t.Fatal(err)
	}
	b2, _ := MarshalTOML(back)
	if string(b2) != string(b) {
		t.Errorf("not stable:\n%s", b2)
	}

}

func TestUnknownConfigKeys(t *testing.T) {
	fsys := fstest.MapFS{"config.toml": {Data: []byte("exclud = ['x']\n[go]\njobz = []\n[ts]\nroots = ['web']\n")}}
	p, err := LoadFS(fsys)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Warnings) != 2 || !strings.Contains(p.Warnings[0], `"exclud"`) || !strings.Contains(p.Warnings[1], `"go.jobz"`) {
		t.Errorf("warnings: %q", p.Warnings)
	}
	if len(p.Config.TS.Roots) != 1 {
		t.Error("known keys should still load")
	}
}
