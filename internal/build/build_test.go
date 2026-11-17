package build

import (
	"testing"

	"codemap/internal/graph"
)

func TestLoadFromGraphFile(t *testing.T) {
	g, p, err := Load("../../testdata/shop", Options{GraphFile: "../../testdata/shop.expected.json"})
	if err != nil {
		t.Fatal(err)
	}
	if errs := graph.Validate(g); len(errs) > 0 {
		t.Fatal(errs)
	}
	if len(p.Areas) == 0 {
		t.Error("project not loaded")
	}
	ix := graph.NewIndex(g)
	if ix.Node["ext:stripe"].Fields["owner"] != "Payments team" {
		t.Error("declared fields missing")
	}
}

func TestLoadWithoutExtractors(t *testing.T) {
	if _, _, err := Load("../../testdata/shop", Options{}); err != ErrNoExtractors {
		t.Fatalf("got %v", err)
	}
}
