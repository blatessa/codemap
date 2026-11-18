package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/gitrev"
)

func TestDiffCommand(t *testing.T) {
	gitrev.CacheRoot = t.TempDir()
	defer func() { gitrev.CacheRoot = "" }()
	root := t.TempDir()
	if err := os.CopyFS(root, os.DirFS("../../testdata/shop")); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Join(root, "web"))
	git := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	git("add", "-A")
	git("commit", "-q", "-m", "initial")
	f := filepath.Join(root, "internal/orders/repo.go")
	b, _ := os.ReadFile(f)
	os.WriteFile(f, append(b, "\n// Purge deletes old orders.\nfunc (r *Repo) Purge(ctx context.Context) error {\n\t_, err := r.db.Exec(ctx, `DELETE FROM users WHERE id = ''`)\n\treturn err\n}\n"...), 0o644)

	var out bytes.Buffer
	if err := runDiff(&out, []string{"--root", root}); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	for _, want := range []string{"→ worktree", "+ Repo.Purge  internal/orders/repo.go:", "+ writes users  by go:shop/internal/orders.(*Repo).Purge", "internal/orders              +1"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in\n%s", want, s)
		}
	}

	git("commit", "-q", "-am", "purge")
	out.Reset()
	if err := runDiff(&out, []string{"--root", root, "--json", "HEAD~1..HEAD"}); err != nil {
		t.Fatal(err)
	}
	var d struct {
		AddedNodes []struct{ ID string } `json:"addedNodes"`
	}
	if err := json.Unmarshal(out.Bytes(), &d); err != nil || len(d.AddedNodes) != 1 {
		t.Errorf("json: %v %s", err, out.String())
	}
	out.Reset()
	if err := runDiff(&out, []string{"--root", root, "HEAD"}); err != nil || !strings.Contains(out.String(), "no architectural changes") {
		t.Errorf("HEAD..worktree after commit: %v %s", err, out.String())
	}
}
