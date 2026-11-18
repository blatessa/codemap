package server

import (
	"io"
	"log"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/build"
	"github.com/blatessa/codemap/internal/extract/goext"
	"github.com/blatessa/codemap/internal/graph"
)

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// newGitServer serves a git repo made from testdata/shop (Go only) with two
// commits; the second adds a function.
func newGitServer(t *testing.T) (*Server, *httptest.Server, string) {
	t.Helper()
	old := build.Extractors
	build.Extractors = []build.Extractor{goext.Extract}
	t.Cleanup(func() { build.Extractors = old })
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	root := t.TempDir()
	if err := os.CopyFS(root, os.DirFS("../../testdata/shop")); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Join(root, "web"))
	gitRun(t, root, "init", "-q", "-b", "main")
	gitRun(t, root, "add", "-A")
	gitRun(t, root, "commit", "-q", "-m", "initial")
	f := filepath.Join(root, "internal/orders/repo.go")
	b, _ := os.ReadFile(f)
	b = append(b, "\n// Count counts orders.\nfunc (r *Repo) Count(ctx context.Context) (n int, err error) {\n\terr = r.db.QueryRow(ctx, `SELECT count(*) FROM orders`).Scan(&n)\n\treturn n, err\n}\n"...)
	os.WriteFile(f, b, 0o644)
	gitRun(t, root, "commit", "-q", "-am", "Add Count")
	s, err := New(Options{Root: root, Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts, root
}

func TestRevEndpoints(t *testing.T) {
	if testing.Short() {
		t.Skip("builds real revisions; run without -short")
	}
	s, ts, root := newGitServer(t)
	events := s.events.subscribe()
	defer s.events.unsubscribe(events)

	var revs revsResponse
	r := do(t, ts, "GET", "/api/revs", nil)
	r.decode(t, &revs)
	if r.status != 200 || len(revs.Commits) != 2 || revs.Current != "main" || revs.Default != "main" || revs.Dirty || revs.PRs == nil {
		t.Fatalf("revs: %d %s", r.status, r.body)
	}
	if revs.Commits[0].Subject != "Add Count" || revs.Commits[0].Refs[0] != "main" {
		t.Errorf("commits: %+v", revs.Commits[0])
	}

	var st struct {
		Graph graph.Graph `json:"graph"`
	}
	r = do(t, ts, "GET", "/api/state?rev=HEAD~1", nil)
	r.decode(t, &st)
	if r.status != 200 || st.Graph.Rev != revs.Commits[1].SHA || len(st.Graph.Nodes) == 0 {
		t.Fatalf("state at HEAD~1: %d rev=%s", r.status, st.Graph.Rev)
	}
	for _, n := range st.Graph.Nodes {
		if strings.HasSuffix(n.ID, ".Count") {
			t.Error("HEAD~1 has Count")
		}
	}
	var sawBuilding bool
	for len(events) > 0 {
		if ev := <-events; ev.Name == "building" && ev.Data.Rev == revs.Commits[1].SHA {
			sawBuilding = true
		}
	}
	if !sawBuilding {
		t.Error("no building event")
	}
	if r := do(t, ts, "PUT", "/api/project/areas?rev=HEAD~1", []any{}); r.status != 405 {
		t.Errorf("write at a rev: %d", r.status)
	}

	var src struct{ Lines []string }
	r = do(t, ts, "GET", "/api/source?rev=HEAD~1&file=internal/orders/repo.go", nil)
	r.decode(t, &src)
	if r.status != 200 || strings.Contains(strings.Join(src.Lines, "\n"), "Count") {
		t.Errorf("source at HEAD~1: %d %d lines", r.status, len(src.Lines))
	}
	if r := do(t, ts, "GET", "/api/state?rev=nope", nil); r.status != 422 {
		t.Errorf("unknown rev: %d", r.status)
	}

	var d graph.GraphDiff
	r = do(t, ts, "GET", "/api/diff?from=HEAD~1&to=HEAD", nil)
	r.decode(t, &d)
	if r.status != 200 || len(d.AddedNodes) != 1 || !strings.HasSuffix(d.AddedNodes[0].ID, "(*Repo).Count") {
		t.Fatalf("diff: %d %s", r.status, r.body)
	}

	var fd struct{ Diff string }
	r = do(t, ts, "GET", "/api/source/diff?from=HEAD~1&to=HEAD&file=internal/orders/repo.go", nil)
	r.decode(t, &fd)
	if r.status != 200 || !strings.Contains(fd.Diff, "+func (r *Repo) Count(") {
		t.Errorf("source diff: %d %s", r.status, r.body)
	}

	// the worktree is the default "to"
	os.WriteFile(filepath.Join(root, "NOTES"), []byte("x"), 0o644)
	r = do(t, ts, "GET", "/api/diff?from=HEAD", nil)
	r.decode(t, &d)
	if r.status != 200 || d.To != "worktree" || !d.Empty() {
		t.Errorf("diff to worktree: %d to=%s", r.status, d.To)
	}
	r = do(t, ts, "GET", "/api/revs", nil)
	r.decode(t, &revs)
	if !revs.Dirty {
		t.Error("not dirty")
	}
}
