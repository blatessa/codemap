package anchor

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"codemap/internal/gitrev"
)

func git(t *testing.T, dir string, args ...string) string {
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

func write(t *testing.T, dir, file, s string) {
	t.Helper()
	full := filepath.Join(dir, file)
	os.MkdirAll(filepath.Dir(full), 0o755)
	if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

const service = `package orders

func (s *Service) Place(ctx context.Context) error {
	if err := s.repo.Insert(ctx, o); err != nil {
		return err
	}
	charge, err := s.payments.Charge(ctx, u.ID, req.Total())
	if err != nil {
		return err
	}
	return nil
}
`

// repo makes a git repo with service.go committed and returns it with HEAD.
func repo(t *testing.T) (string, string, *gitrev.Repo) {
	t.Helper()
	gitrev.CacheRoot = t.TempDir()
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	write(t, dir, "internal/orders/service.go", service)
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")
	r, err := gitrev.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return dir, git(t, dir, "rev-parse", "HEAD"), r
}

func item(rev string) map[string]any {
	return map[string]any{
		"id": "i1", "kind": "change", "file": "internal/orders/service.go",
		"lines": []any{int64(7), int64(7)}, "quote": "charge, err := s.payments.Charge(ctx, u.ID, req.Total())", "rev": rev,
	}
}

func TestUnchanged(t *testing.T) {
	dir, head, r := repo(t)
	a := (&Resolver{Root: dir, Repo: r}).Resolve(item(head))
	if a == nil || a.Stale || a.Lines != [2]int{7, 7} || a.File != "internal/orders/service.go" {
		t.Fatalf("got %+v", a)
	}
}

func TestCodeMoved(t *testing.T) {
	dir, head, r := repo(t)
	// three lines added above
	write(t, dir, "internal/orders/service.go", strings.Replace(service, "package orders\n", "package orders\n\n// Service places orders.\n// It charges after inserting.\n", 1))
	a := (&Resolver{Root: dir, Repo: r}).Resolve(item(head))
	if a.Stale || a.Lines != [2]int{10, 10} {
		t.Fatalf("got %+v", a)
	}
	// and committed: still found, through the diff from the item's rev
	git(t, dir, "commit", "-qam", "doc")
	a = (&Resolver{Root: dir, Repo: r}).Resolve(item(head))
	if a.Stale || a.Lines != [2]int{10, 10} {
		t.Fatalf("after commit: got %+v", a)
	}
}

func TestQuoteGone(t *testing.T) {
	dir, head, r := repo(t)
	write(t, dir, "internal/orders/service.go", strings.Replace(service, "charge, err := s.payments.Charge(ctx, u.ID, req.Total())", "id, err := s.payments.Authorize(ctx, u.ID)", 1))
	a := (&Resolver{Root: dir, Repo: r}).Resolve(item(head))
	if !a.Stale || a.Lines != [2]int{7, 7} {
		t.Fatalf("got %+v", a)
	}
}

func TestFileRenamed(t *testing.T) {
	dir, head, r := repo(t)
	git(t, dir, "mv", "internal/orders/service.go", "internal/orders/place.go")
	git(t, dir, "commit", "-qm", "rename")
	a := (&Resolver{Root: dir, Repo: r}).Resolve(item(head))
	if a.Stale || a.File != "internal/orders/place.go" || a.Lines != [2]int{7, 7} {
		t.Fatalf("got %+v", a)
	}
}

func TestFileDeleted(t *testing.T) {
	dir, head, r := repo(t)
	os.Remove(filepath.Join(dir, "internal/orders/service.go"))
	a := (&Resolver{Root: dir, Repo: r}).Resolve(item(head))
	if !a.Stale {
		t.Fatalf("got %+v", a)
	}
}

func TestNoGit(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "internal/orders/service.go", "// moved\n"+service)
	it := item("3f2c9e1")
	a := (&Resolver{Root: dir}).Resolve(it)
	if a.Stale || a.Lines != [2]int{8, 8} {
		t.Fatalf("got %+v", a)
	}
	delete(it, "file")
	if (&Resolver{Root: dir}).Resolve(it) != nil {
		t.Fatal("an item without a file has no anchor")
	}
}

func TestFindMultiLineNearest(t *testing.T) {
	src := strings.Split("a\nif err != nil {\n\treturn err\n}\nb\nif err != nil {\n\treturn err\n}\n", "\n")
	q := "if err != nil {\nreturn err\n}"
	if at, n := Find(src, q, 6); at != 6 || n != 3 {
		t.Fatalf("near 6: %d %d", at, n)
	}
	if at, _ := Find(src, q, 1); at != 2 {
		t.Fatalf("near 1: %d", at)
	}
}

func TestShift(t *testing.T) {
	// 2 lines inserted after line 3, line 10 replaced by 3 lines
	h := [][4]int{{3, 0, 4, 2}, {10, 1, 12, 3}}
	for _, c := range [][2]int{{1, 1}, {3, 3}, {4, 6}, {9, 11}, {10, 12}, {11, 15}} {
		if got := Shift(h, c[0]); got != c[1] {
			t.Errorf("Shift(%d) = %d, want %d", c[0], got, c[1])
		}
	}
}
