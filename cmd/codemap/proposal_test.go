package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codemap/internal/cli"
)

// TestProposalGolden runs proposal list, new and archive on a temp copy of the
// fixture's .codemap directory and checks the output and the files written.
func TestProposalGolden(t *testing.T) {
	dir := goldenDir(t)
	root := t.TempDir()
	if err := os.CopyFS(filepath.Join(root, ".codemap"), os.DirFS(filepath.Join("..", "..", "testdata", "shop", ".codemap"))); err != nil {
		t.Fatal(err)
	}
	oldToday, oldHead := today, gitHead
	today = func() string { return "2026-11-17" }
	gitHead = func(string) string { return "3f2c9e1a" }
	t.Cleanup(func() { today, gitHead = oldToday, oldHead })

	run := func(stdin string, args ...string) (string, int) {
		var out, errOut bytes.Buffer
		code := cli.Report(&errOut, runProposal(&out, strings.NewReader(stdin), append([]string{"--root", root}, args...)))
		s := out.String()
		if code != 0 || errOut.Len() > 0 {
			s += fmt.Sprintf("--- exit %d\n%s", code, strings.ReplaceAll(errOut.String(), root, "ROOT"))
		}
		return s, code
	}
	file := func(slug string) string {
		b, err := os.ReadFile(filepath.Join(root, ".codemap", "proposals", slug+".md"))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	var log strings.Builder
	step := func(title string, wantCode int, stdin string, args ...string) {
		got, code := run(stdin, args...)
		if code != wantCode {
			t.Errorf("%s: exit %d, want %d\n%s", title, code, wantCode, got)
		}
		fmt.Fprintf(&log, "$ codemap proposal %s\n%s\n", strings.Join(args, " "), got)
	}

	step("list", 0, "", "list")
	step("list json", 0, "", "list", "--json")
	step("new", 0, "## Why\nRefund part of an order.\n", "new", "Partial refunds", "--body", "-")
	fmt.Fprintf(&log, "# partial-refunds.md\n%s\n", file("partial-refunds"))
	step("new again", 1, "", "new", "Partial refunds")
	step("new json", 0, "", "new", "Gift cards!", "--json")
	step("archive", 0, "", "archive", "refunds", "--pr", "91")
	fmt.Fprintf(&log, "# refunds.md\n%s\n", file("refunds"))
	step("archive json", 0, "", "archive", "gift-cards", "--json")
	step("archive missing", 1, "", "archive", "nope")
	step("list after", 0, "", "list")
	step("bad subcommand", 2, "", "frobnicate")

	checkGolden(t, dir, "proposal.golden", log.String())
}
