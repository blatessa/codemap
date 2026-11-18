package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codemap/internal/cli"
	"codemap/internal/gitrev"
)

// TestProposalGolden runs proposal list, new and archive on a temp copy of the
// fixture's .codemap directory and checks the output and the files written.
func TestProposalGolden(t *testing.T) {
	dir := goldenDir(t)
	root := t.TempDir()
	if err := os.CopyFS(root, os.DirFS(filepath.Join("..", "..", "testdata", "shop"))); err != nil {
		t.Fatal(err)
	}
	oldToday, oldHead, oldRepo := today, gitHead, openRepo
	today = func() string { return "2026-11-17" }
	gitHead = func(string) string { return "3f2c9e1a" }
	openRepo = func(string) *gitrev.Repo { return nil }
	t.Cleanup(func() { today, gitHead, openRepo = oldToday, oldHead, oldRepo })

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
	// items: show, request, item
	step("show", 0, "", "show", "refunds")
	step("show open json", 0, "", "show", "refunds", "--status", "open", "--json")
	step("request code", 0, "", "request", "refunds", "--kind", "change", "--target", "go:shop/internal/orders.(*Service).MarkPaid",
		"--file", "internal/orders/service.go", "--lines", "66-69", "--text", "Ignore a webhook for an unknown charge")
	step("request edge", 0, "", "request", "refunds", "--kind", "question", "--target", "new:orders.Service.Refund -> topic:order.placed", "--text", "Why publish order.placed on a refund?")
	step("request bad kind", 2, "", "request", "refunds", "--kind", "frob", "--target", "x", "--text", "y")
	step("request no text", 2, "", "request", "refunds", "--target", "x")
	step("item done", 0, "", "item", "refunds", "i1", "--status", "done", "--reply", "Moved the charge after Insert; Place refunds the reservation on failure.")
	step("item wontfix", 0, "", "item", "refunds", "i5", "--status", "wontfix", "--reply", "Stock listens to order.placed; a refund should release it. Keep?")
	step("item missing", 1, "", "item", "refunds", "i9", "--status", "done")
	step("item bad status", 2, "", "item", "refunds", "i2", "--status", "finished")
	fmt.Fprintf(&log, "# refunds.md\n%s\n", file("refunds"))
	// the code moves: the anchor follows the quote
	svc := filepath.Join(root, "internal", "orders", "service.go")
	b, _ := os.ReadFile(svc)
	os.WriteFile(svc, []byte(strings.Replace(string(b), "// Place reserves", "// moved\n// down\n// Place reserves", 1)), 0o644)
	step("show after move", 0, "", "show", "refunds")
	step("show done", 0, "", "show", "refunds", "--status", "done")
	os.WriteFile(svc, []byte(strings.Replace(string(b), "charge, err := s.payments.Charge(ctx, u.ID, req.Total())", "charge, err := s.payments.Authorize(ctx, u.ID)", 1)), 0o644)
	step("show stale", 0, "", "show", "refunds", "--status", "done")
	step("archive", 0, "", "archive", "refunds", "--pr", "91")
	fmt.Fprintf(&log, "# refunds.md\n%s\n", file("refunds"))
	step("archive json", 0, "", "archive", "gift-cards", "--json")
	step("archive missing", 1, "", "archive", "nope")
	step("list after", 0, "", "list")
	step("bad subcommand", 2, "", "frobnicate")

	checkGolden(t, dir, "proposal.golden", log.String())
}
