package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestModulesFlagsBadAreas(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".codemap")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	areas := "[[area]]\nname = 'A'\nmodules = ['mod:nope', 'mod:go:shop/internal/orders']\n\n[[area]]\nname = 'B'\nmodules = ['mod:go:shop/internal/orders']\n"
	if err := os.WriteFile(filepath.Join(dir, "areas.toml"), []byte(areas), 0o644); err != nil {
		t.Fatal(err)
	}
	graph, _ := filepath.Abs("../../testdata/shop.expected.json")
	out, code := runCmd(runModules, []string{"--root", root, "--graph", graph})
	if code != 0 {
		t.Fatal(out)
	}
	for _, want := range []string{
		"mod:go:shop/internal/orders  ",
		`area "A" lists mod:nope, which isn't a module or block`,
		`mod:go:shop/internal/orders is in two areas: "A" and "B"`,
		"not in an area",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}
