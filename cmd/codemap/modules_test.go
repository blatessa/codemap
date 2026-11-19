package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestModulesFlagsBadBlocks(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".codemap")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	blocks := "[[block]]\nid = 'block:x'\nname = 'X'\nfrom = 'mod:nope'\n"
	if err := os.WriteFile(filepath.Join(dir, "blocks.toml"), []byte(blocks), 0o644); err != nil {
		t.Fatal(err)
	}
	graph, _ := filepath.Abs("../../testdata/shop.expected.json")
	out, code := runCmd(runModules, []string{"--root", root, "--graph", graph})
	if code != 0 {
		t.Fatal(out)
	}
	for _, want := range []string{
		"mod:go:shop/internal/orders  ",
		`block "X" splits mod:nope, which isn't a module`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}
