package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/cli"
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

// TestProposalShow: the review view groups changes by part, flags a sketch that
// can't work, and puts each note beside the code it is about.
func TestProposalShow(t *testing.T) {
	root := t.TempDir()
	if err := os.CopyFS(filepath.Join(root, ".codemap"), os.DirFS(filepath.Join("..", "..", "testdata", "shop", ".codemap"))); err != nil {
		t.Fatal(err)
	}
	file := `+++
name = 'Audit'
status = 'open'

[[node]]
id = 'new:orders.Service.Audit'
kind = 'function'
label = 'Service.Audit'
doc = 'Records who changed an order.'
module = 'mod:go:shop/internal/orders'

[[edge]]
from = 'new:orders.Service.Audit'
to = 'table:nope'

[[note]]
on = 'new:orders.Service.Audit'
text = 'Write one row per change.'

[[note]]
file = 'internal/orders/repo.go'
from = 25
quote = 'not the code'
text = 'Find is where this belongs.'
+++
Why.
`
	if err := os.WriteFile(filepath.Join(root, ".codemap", "proposals", "audit.md"), []byte(file), 0o644); err != nil {
		t.Fatal(err)
	}
	// the code the second note quotes lives in the fixture
	if err := os.CopyFS(filepath.Join(root, "internal"), os.DirFS(filepath.Join("..", "..", "testdata", "shop", "internal"))); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runProposal(&out, strings.NewReader(""), []string{"--root", root, "show", "audit"}); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"+ orders.Service.Audit\n        Records who changed an order.",
		`a call mentions "table:nope"`,
		"nothing calls orders.Service.Audit",
		"1. orders.Service.Audit\n     Write one row per change.",
		"2. internal/orders/repo.go:25",
		"| not the code",
		"the code at these lines has changed",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if err := runProposal(&out, strings.NewReader(""), []string{"--root", root, "show", "nope"}); err == nil {
		t.Error("an unknown proposal should be an error")
	}
}
