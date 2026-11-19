package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestModules(t *testing.T) {
	graph, _ := filepath.Abs("../../testdata/shop.expected.json")
	out, code := runCmd(runModules, []string{"--root", t.TempDir(), "--graph", graph})
	if code != 0 {
		t.Fatal(out)
	}
	if !strings.Contains(out, "mod:go:shop/internal/orders  ") {
		t.Errorf("missing orders in:\n%s", out)
	}
}
