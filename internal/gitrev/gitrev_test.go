package gitrev

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"codemap/internal/build"
	"codemap/internal/extract/goext"
	"codemap/internal/graph"
)

func TestMain(m *testing.M) {
	build.Extractors = []build.Extractor{goext.Extract}
	os.Exit(m.Run())
}

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func edit(t *testing.T, dir, file, old, new string) {
	t.Helper()
	p := filepath.Join(dir, file)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), old) {
		t.Fatalf("%s: %q not found", file, old)
	}
	if err := os.WriteFile(p, []byte(strings.Replace(string(b), old, new, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// shopRepo makes a git repo from a copy of testdata/shop (Go and SQL only)
// with four commits:
//
//	c1 initial
//	c2 add POST /orders/{id}/cancel, whose repo method writes the users table
//	c3 change Repo.Find's body, and shift Repo.Insert down without changing it
//	c4 delete the GET /orders/{id} route and Handler.Get
func shopRepo(t *testing.T) (dir string, c []string) {
	t.Helper()
	dir = t.TempDir()
	if err := os.CopyFS(dir, os.DirFS("../../testdata/shop")); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Join(dir, "web"))
	run(t, dir, "git", "init", "-q", "-b", "main")
	commit := func(msg string) {
		run(t, dir, "git", "add", "-A")
		run(t, dir, "git", "commit", "-q", "-m", msg)
		c = append(c, run(t, dir, "git", "rev-parse", "HEAD"))
	}
	commit("initial")

	edit(t, dir, "cmd/server/routes.go", `	r.Post("/webhooks/stripe"`, `	r.With(authH.RequireUser).Post("/orders/{id}/cancel", ordersH.Cancel)
	r.Post("/webhooks/stripe"`)
	edit(t, dir, "internal/orders/handler.go", "func writeJSON(", `// Cancel cancels an order.
func (h *Handler) Cancel(w http.ResponseWriter, r *http.Request) {
	if err := h.repo.Cancel(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(`)
	edit(t, dir, "internal/orders/repo.go", "// Find loads", `// Cancel marks an order cancelled and remembers it on the user.
func (r *Repo) Cancel(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx, `+"`UPDATE users SET last_cancel = now() WHERE id = (SELECT user_id FROM orders WHERE id = $1)`"+`, id)
	return err
}

// Find loads`)
	commit("Add order cancel")

	edit(t, dir, "internal/orders/repo.go", "// Repo stores orders.", "// Repo stores orders.\n//\n// It is safe for concurrent use.")
	edit(t, dir, "internal/orders/repo.go", "	var o Order\n	err := r.db.QueryRow(ctx, `SELECT * FROM orders WHERE id = $1`", "	var o Order\n	if id == \"\" {\n		return nil, nil\n	}\n	err := r.db.QueryRow(ctx, `SELECT * FROM orders WHERE id = $1`")
	commit("Find: empty id")

	edit(t, dir, "cmd/server/routes.go", "	r.With(authH.RequireUser).Get(\"/orders/{id}\", ordersH.Get)\n", "")
	edit(t, dir, "internal/orders/handler.go", `// Get returns one order.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	o, err := h.repo.Find(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, o)
}
`, "")
	commit("Drop GET /orders/{id}")
	return dir, c
}

func openRepo(t *testing.T, dir string) *Repo {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	r, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r
}

func hasSuffix(ids []string, suf string) bool {
	return slices.ContainsFunc(ids, func(s string) bool { return strings.HasSuffix(s, suf) })
}

func nodeIDs(ns []graph.Node) []string {
	var out []string
	for _, n := range ns {
		out = append(out, n.ID)
	}
	return out
}

func refIDs(rs []graph.Ref) []string {
	var out []string
	for _, r := range rs {
		out = append(out, r.ID)
	}
	return out
}

func TestDiffAcrossCommits(t *testing.T) {
	if testing.Short() {
		t.Skip("builds real revisions; run without -short")
	}
	dir, c := shopRepo(t)
	r := openRepo(t, dir)
	ctx := context.Background()
	wt := func() (*graph.Graph, error) { return build.Graph(dir, nil, build.Options{}) }

	t.Run("add route and SQL write", func(t *testing.T) {
		d, err := r.Diff(ctx, Range{c[0], c[1]}, wt)
		if err != nil {
			t.Fatal(err)
		}
		added := nodeIDs(d.AddedNodes)
		if !hasSuffix(added, "orders.(*Handler).Cancel") || !hasSuffix(added, "orders.(*Repo).Cancel") {
			t.Errorf("added = %v", added)
		}
		if !slices.ContainsFunc(refIDs(d.Summary.EntriesAdded), func(s string) bool { return strings.Contains(s, "cancel") }) {
			t.Errorf("entries added = %v", d.Summary.EntriesAdded)
		}
		var wrote bool
		for _, x := range d.Summary.DataAdded {
			if x.Type == graph.Writes && strings.Contains(x.ID, "users") {
				wrote = true
			}
		}
		if !wrote {
			t.Errorf("data added = %+v", d.Summary.DataAdded)
		}
		if len(d.RemovedNodes) != 0 {
			t.Errorf("removed = %v", nodeIDs(d.RemovedNodes))
		}
		if hasSuffix(d.Changed, "orders.(*Repo).Find") {
			t.Errorf("Find moved but did not change: changed = %v", d.Changed)
		}
		if len(d.AddedEdges) == 0 {
			t.Error("no added edges")
		}
	})

	t.Run("body change vs moved lines", func(t *testing.T) {
		d, err := r.Diff(ctx, Range{c[1], c[2]}, wt)
		if err != nil {
			t.Fatal(err)
		}
		if !hasSuffix(d.Changed, "orders.(*Repo).Find") {
			t.Errorf("changed = %v, want Find", d.Changed)
		}
		if hasSuffix(d.Changed, "orders.(*Repo).Insert") || hasSuffix(d.Changed, "orders.(*Repo).UpdateStatus") {
			t.Errorf("changed = %v: moved functions count as changed", d.Changed)
		}
		if len(d.AddedNodes)+len(d.RemovedNodes) != 0 {
			t.Errorf("added %v removed %v", nodeIDs(d.AddedNodes), nodeIDs(d.RemovedNodes))
		}
		var m *graph.ModCounts
		for i := range d.Summary.Modules {
			if strings.HasSuffix(d.Summary.Modules[i].ID, "internal/orders") {
				m = &d.Summary.Modules[i]
			}
		}
		if m == nil || m.Changed < 1 {
			t.Errorf("modules = %+v", d.Summary.Modules)
		}
	})

	t.Run("delete function and route", func(t *testing.T) {
		d, err := r.Diff(ctx, Range{c[2], c[3]}, wt)
		if err != nil {
			t.Fatal(err)
		}
		if !hasSuffix(nodeIDs(d.RemovedNodes), "orders.(*Handler).Get") {
			t.Errorf("removed = %v", nodeIDs(d.RemovedNodes))
		}
		if len(d.Summary.EntriesRemoved) != 1 {
			t.Errorf("entries removed = %v", d.Summary.EntriesRemoved)
		}
		if len(d.RemovedEdges) == 0 {
			t.Error("no removed edges")
		}
	})

	t.Run("uncommitted worktree", func(t *testing.T) {
		edit(t, dir, "internal/orders/repo.go", "	if id == \"\" {", "	if id == \"\" || id == \"0\" {")
		defer run(t, dir, "git", "checkout", "--", ".")
		rg, err := r.ResolveRange(ctx, "HEAD", Worktree)
		if err != nil {
			t.Fatal(err)
		}
		d, err := r.Diff(ctx, rg, wt)
		if err != nil {
			t.Fatal(err)
		}
		if d.To != Worktree || !slices.Equal(d.Changed, []string{"go:shop/internal/orders.(*Repo).Find"}) {
			t.Errorf("to %s changed %v", d.To, d.Changed)
		}
		if !r.Dirty(ctx) {
			t.Error("not dirty")
		}
	})
}

func TestBuildCacheAndPool(t *testing.T) {
	if testing.Short() {
		t.Skip("builds real revisions; run without -short")
	}
	dir, c := shopRepo(t)
	r := openRepo(t, dir)
	ctx := context.Background()
	var mu sync.Mutex
	builds := 0
	r.Progress = func(sha, phase string) {
		if phase == "extract" {
			mu.Lock()
			builds++
			mu.Unlock()
		}
	}
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g, p, err := r.Build(ctx, "HEAD~1")
			if err != nil {
				t.Error(err)
				return
			}
			if g.Rev != c[2] || len(g.Nodes) == 0 || p == nil {
				t.Errorf("rev %s nodes %d", g.Rev, len(g.Nodes))
			}
		}()
	}
	wg.Wait()
	if builds != 1 {
		t.Errorf("%d builds for one rev, want 1 (dedupe)", builds)
	}
	if !r.Cached(ctx, c[2]) {
		t.Error("not cached")
	}
	if _, _, err := r.Build(ctx, c[2]); err != nil || builds != 1 {
		t.Errorf("rebuilt from cache: %v builds=%d", err, builds)
	}
	ents, _ := os.ReadDir(r.CacheDir)
	var zst bool
	for _, e := range ents {
		zst = zst || strings.HasSuffix(e.Name(), ".json.zst")
	}
	if !zst {
		t.Error("no .json.zst cache file")
	}

	// the pooled worktree is reused and removed on Close
	if _, _, err := r.Build(ctx, "main~3"); err != nil {
		t.Fatal(err)
	}
	pool, _ := os.ReadDir(r.poolDir())
	if len(pool) != 1 {
		t.Errorf("pool has %d worktrees, want 1", len(pool))
	}
	r.Close()
	if out := run(t, dir, "git", "worktree", "list"); strings.Count(out, "\n") != 0 {
		t.Errorf("worktrees left:\n%s", out)
	}
}

func TestPruneStale(t *testing.T) {
	dir, _ := shopRepo(t)
	r := openRepo(t, dir)
	// a worktree left by a process that no longer exists
	stale := filepath.Join(r.poolDir(), "999999999-1")
	os.MkdirAll(r.poolDir(), 0o755)
	run(t, dir, "git", "worktree", "add", "-q", "--detach", stale, "HEAD")
	if _, err := Open(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("stale worktree not removed")
	}
	if out := run(t, dir, "git", "worktree", "list"); strings.Contains(out, "999999999") {
		t.Errorf("git still lists it:\n%s", out)
	}
}

func TestRevsAndSource(t *testing.T) {
	dir, c := shopRepo(t)
	r := openRepo(t, dir)
	ctx := context.Background()
	log, err := r.Log(ctx, 10)
	if err != nil || len(log) != 4 || log[0].SHA != c[3] || log[0].Subject != "Drop GET /orders/{id}" || !slices.Contains(log[0].Refs, "main") {
		t.Fatalf("log = %+v, %v", log, err)
	}
	if b := r.CurrentBranch(ctx); b != "main" {
		t.Errorf("branch %q", b)
	}
	if b := r.DefaultBranch(ctx); b != "main" {
		t.Errorf("default %q", b)
	}
	if r.Dirty(ctx) {
		t.Error("dirty")
	}
	src, err := r.Show(ctx, c[0], "cmd/server/routes.go")
	if err != nil || !strings.Contains(string(src), `Get("/orders/{id}"`) {
		t.Errorf("show: %v", err)
	}
	fd, err := r.FileDiff(ctx, c[2], c[3], "internal/orders/handler.go", 3)
	if err != nil || !strings.Contains(string(fd), "-func (h *Handler) Get(") {
		t.Errorf("file diff: %v\n%s", err, fd)
	}
	rg, err := r.ResolveRange(ctx, "base:main", "HEAD")
	if err != nil || rg.From != c[3] {
		t.Errorf("base:main = %+v %v", rg, err)
	}
	for spec, want := range map[string][2]string{
		"":             {"HEAD", Worktree},
		"HEAD~1..HEAD": {"HEAD~1", "HEAD"},
		"main...":      {"base:main", Worktree},
		"abc":          {"abc", Worktree},
		"pr:12":        {"pr:12", ""},
	} {
		if f, to := ParseRange(spec); f != want[0] || to != want[1] {
			t.Errorf("ParseRange(%q) = %q %q", spec, f, to)
		}
	}
}

func TestRename(t *testing.T) {
	if testing.Short() {
		t.Skip("builds real revisions; run without -short")
	}
	dir, _ := shopRepo(t)
	r := openRepo(t, dir)
	ctx := context.Background()
	run(t, dir, "git", "mv", "internal/orders/repo.go", "internal/orders/store.go")
	edit(t, dir, "internal/orders/store.go", "	if id == \"\" {", "	if id == \"x\" {")
	run(t, dir, "git", "commit", "-q", "-am", "rename")
	d, err := r.Diff(ctx, Range{mustResolve(t, r, "HEAD~1"), mustResolve(t, r, "HEAD")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(d.Changed, []string{"go:shop/internal/orders.(*Repo).Find"}) {
		t.Errorf("changed after rename = %v", d.Changed)
	}
}

func mustResolve(t *testing.T, r *Repo, rev string) string {
	sha, err := r.Resolve(context.Background(), rev)
	if err != nil {
		t.Fatal(err)
	}
	return sha
}

func TestParseUnified(t *testing.T) {
	out := []byte(`diff --git a/x.go b/y.go
similarity index 90%
rename from x.go
rename to y.go
index 1..2 100644
--- a/x.go
+++ b/y.go
@@ -3,0 +4,2 @@ func a
@@ -10,2 +12 @@
diff --git a/new.go b/new.go
new file mode 100644
--- /dev/null
+++ b/new.go
@@ -0,0 +1,5 @@
diff --git a/gone.go b/gone.go
deleted file mode 100644
--- a/gone.go
+++ /dev/null
@@ -1,4 +0,0 @@
`)
	fc := ParseUnified(out)
	if len(fc) != 3 {
		t.Fatalf("%+v", fc)
	}
	if fc[0].Old != "x.go" || fc[0].New != "y.go" || !slices.Equal(fc[0].NewHunks, [][2]int{{4, 5}, {12, 12}}) || !slices.Equal(fc[0].OldHunks, [][2]int{{10, 11}}) {
		t.Errorf("rename: %+v", fc[0])
	}
	if fc[1].Old != "" || fc[1].New != "new.go" || fc[2].New != "" || fc[2].Old != "gone.go" {
		t.Errorf("%+v %+v", fc[1], fc[2])
	}
}
