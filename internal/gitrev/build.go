package gitrev

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/klauspost/compress/zstd"

	"codemap/internal/build"
	"codemap/internal/graph"
	"codemap/internal/project"
)

func newHash() hash.Hash { return sha256.New() }

func hexSum(h hash.Hash, n int) string { return hex.EncodeToString(h.Sum(nil)[:n]) }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// MaxBuilds is how many revisions build at the same time.
const MaxBuilds = 2

// ExtractFunc builds the merged graph for a checkout at dir.
type ExtractFunc func(dir string, proj *project.Project) (*graph.Graph, error)

// Progress receives build phases ("checkout", "extract", "done") for a rev.
type Progress func(sha, phase string)

// Repo is a git repository codemap builds revisions of.
type Repo struct {
	Root     string // the worktree's top-level directory
	CacheDir string // $XDG_CACHE_HOME/codemap/<repo-id>

	// Extract runs the extractors. Nil uses build.Graph.
	Extract ExtractFunc
	// Progress, if set, is told about builds as they run.
	Progress Progress

	sem chan struct{}

	mu       sync.Mutex
	inflight map[string]*call
	free     []string // idle pooled worktrees
	made     int
}

type call struct {
	done chan struct{}
	g    *graph.Graph
	err  error
}

// Open finds the repository containing dir and prepares its cache directory.
// It also removes worktrees left behind by codemap processes that died.
func Open(dir string) (*Repo, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	top, err := gitLine(ctx, abs, "rev-parse", "--show-toplevel")
	if err != nil || top == "" {
		return nil, ErrNotGit
	}
	common, err := gitLine(ctx, abs, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return nil, ErrNotGit
	}
	base := os.Getenv("XDG_CACHE_HOME")
	if base == "" {
		if base, err = os.UserCacheDir(); err != nil {
			base = filepath.Join(os.TempDir(), "codemap-cache")
		}
	}
	sum := sha256.Sum256([]byte(common))
	id := filepath.Base(top) + "-" + hex.EncodeToString(sum[:6])
	r := &Repo{Root: top, CacheDir: filepath.Join(base, "codemap", id), sem: make(chan struct{}, MaxBuilds), inflight: map[string]*call{}}
	if err := os.MkdirAll(r.CacheDir, 0o755); err != nil {
		return nil, err
	}
	r.pruneStale()
	return r, nil
}

func (r *Repo) poolDir() string { return filepath.Join(r.CacheDir, "wt") }

// pruneStale removes pooled worktrees whose owning process is gone, then lets
// git forget worktrees whose directories no longer exist.
func (r *Repo) pruneStale() {
	ents, _ := os.ReadDir(r.poolDir())
	ctx := context.Background()
	for _, e := range ents {
		pid, err := strconv.Atoi(strings.SplitN(e.Name(), "-", 2)[0])
		if err == nil && pid != os.Getpid() && alive(pid) {
			continue
		}
		p := filepath.Join(r.poolDir(), e.Name())
		git(ctx, r.Root, "worktree", "remove", "--force", p)
		os.RemoveAll(p)
	}
	git(ctx, r.Root, "worktree", "prune")
}

func alive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// Close removes this process's pooled worktrees.
func (r *Repo) Close() {
	r.mu.Lock()
	dirs := r.free
	r.free = nil
	r.mu.Unlock()
	ctx := context.Background()
	for _, d := range dirs {
		git(ctx, r.Root, "worktree", "remove", "--force", d)
		os.RemoveAll(d)
	}
	git(ctx, r.Root, "worktree", "prune")
}

// extractorVersion identifies the extractors' code: the format version plus a
// hash of the running binary, so a rebuilt codemap never reuses stale graphs.
var extractorVersion = sync.OnceValue(func() string {
	h := newHash()
	fmt.Fprintf(h, "graph-v%d build-v%s\x00", graph.Version, build.Version)
	if exe, err := os.Executable(); err == nil {
		if f, err := os.Open(exe); err == nil {
			io.Copy(h, f)
			f.Close()
		}
	}
	return hexSum(h, 6)
})

// CachePath is where the graph for sha with the given config hash is cached.
func (r *Repo) CachePath(sha, cfgHash string) string {
	return filepath.Join(r.CacheDir, fmt.Sprintf("%s-%s-%s.json.zst", sha, extractorVersion(), cfgHash))
}

// Build returns the graph and project at rev (a commit, branch, tag or
// anything git resolves). Results are cached on disk by commit; concurrent
// requests for the same build share it.
func (r *Repo) Build(ctx context.Context, rev string) (*graph.Graph, *project.Project, error) {
	sha, err := r.Resolve(ctx, rev)
	if err != nil {
		return nil, nil, err
	}
	proj, cfgHash, err := r.Project(ctx, sha)
	if err != nil {
		return nil, nil, err
	}
	g, err := r.buildSHA(ctx, sha, proj, cfgHash)
	return g, proj, err
}

// Cached reports whether rev's graph is already on disk (so Build is fast).
func (r *Repo) Cached(ctx context.Context, rev string) bool {
	sha, err := r.Resolve(ctx, rev)
	if err != nil {
		return false
	}
	_, cfgHash, err := r.Project(ctx, sha)
	if err != nil {
		return false
	}
	_, err = os.Stat(r.CachePath(sha, cfgHash))
	return err == nil
}

func (r *Repo) buildSHA(ctx context.Context, sha string, proj *project.Project, cfgHash string) (*graph.Graph, error) {
	path := r.CachePath(sha, cfgHash)
	if g, err := readCache(path); err == nil {
		return g, nil
	}
	r.mu.Lock()
	c := r.inflight[path]
	if c == nil {
		c = &call{done: make(chan struct{})}
		r.inflight[path] = c
		go func() {
			// detached from ctx: a build others may wait on finishes even if this caller leaves
			c.g, c.err = r.run(sha, proj, path)
			r.mu.Lock()
			delete(r.inflight, path)
			r.mu.Unlock()
			close(c.done)
		}()
	}
	r.mu.Unlock()
	select {
	case <-c.done:
		if c.err != nil {
			return nil, c.err
		}
		return clone(c.g), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func clone(g *graph.Graph) *graph.Graph {
	c := *g
	c.Modules = append([]graph.Module(nil), g.Modules...)
	c.Nodes = append([]graph.Node(nil), g.Nodes...)
	c.Edges = append([]graph.Edge(nil), g.Edges...)
	return &c
}

func (r *Repo) progress(sha, phase string) {
	if r.Progress != nil {
		r.Progress(sha, phase)
	}
}

func (r *Repo) run(sha string, proj *project.Project, path string) (*graph.Graph, error) {
	r.sem <- struct{}{}
	defer func() { <-r.sem }()
	r.progress(sha, "checkout")
	defer r.progress(sha, "done")
	dir, err := r.checkout(sha)
	if err != nil {
		return nil, err
	}
	defer r.release(dir)
	r.linkNodeModules(dir, proj)
	r.progress(sha, "extract")
	extract := r.Extract
	if extract == nil {
		extract = func(dir string, proj *project.Project) (*graph.Graph, error) {
			return build.Graph(dir, proj, build.Options{})
		}
	}
	g, err := extract(dir, proj)
	if err != nil {
		return nil, fmt.Errorf("build %s: %w", short(sha), err)
	}
	g.Rev = sha
	if err := writeCache(path, g); err != nil {
		return nil, err
	}
	return g, nil
}

// checkout takes an idle pooled worktree (or makes one) and checks sha out in it.
func (r *Repo) checkout(sha string) (string, error) {
	ctx := context.Background()
	r.mu.Lock()
	var dir string
	if n := len(r.free); n > 0 {
		dir, r.free = r.free[n-1], r.free[:n-1]
	} else {
		r.made++
		dir = filepath.Join(r.poolDir(), fmt.Sprintf("%d-%d", os.Getpid(), r.made))
	}
	r.mu.Unlock()
	if _, err := os.Stat(dir); err == nil {
		if _, err := git(ctx, dir, "checkout", "--quiet", "--force", "--detach", sha); err == nil {
			if _, err := git(ctx, dir, "clean", "-ffdxq"); err == nil {
				return dir, nil
			}
		}
		git(ctx, r.Root, "worktree", "remove", "--force", dir)
		os.RemoveAll(dir)
	}
	if err := os.MkdirAll(r.poolDir(), 0o755); err != nil {
		return "", err
	}
	if _, err := git(ctx, r.Root, "worktree", "add", "--quiet", "--force", "--detach", dir, sha); err != nil {
		git(ctx, r.Root, "worktree", "prune")
		if _, err2 := git(ctx, r.Root, "worktree", "add", "--quiet", "--force", "--detach", dir, sha); err2 != nil {
			return "", err
		}
	}
	return dir, nil
}

func (r *Repo) release(dir string) {
	r.mu.Lock()
	r.free = append(r.free, dir)
	r.mu.Unlock()
}

// linkNodeModules symlinks node_modules directories from the main checkout
// into the build checkout, so the TypeScript extractor resolves packages the
// same way. git clean removes the links on the next reuse.
func (r *Repo) linkNodeModules(dir string, proj *project.Project) {
	roots := append([]string{"."}, proj.Config.TS.Roots...)
	for _, root := range roots {
		src := filepath.Join(r.Root, root, "node_modules")
		dst := filepath.Join(dir, root, "node_modules")
		if fi, err := os.Stat(src); err != nil || !fi.IsDir() {
			continue
		}
		if _, err := os.Lstat(dst); err == nil {
			continue
		}
		if _, err := os.Stat(filepath.Dir(dst)); err != nil {
			continue
		}
		os.Symlink(src, dst)
	}
}

func readCache(path string) (*graph.Graph, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	zr, err := zstd.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return graph.Decode(zr)
}

func writeCache(path string, g *graph.Graph) error {
	var raw bytes.Buffer
	if err := g.Encode(&raw); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	zw, _ := zstd.NewWriter(tmp)
	_, err = zw.Write(raw.Bytes())
	if err2 := zw.Close(); err == nil {
		err = err2
	}
	if err2 := tmp.Close(); err == nil {
		err = err2
	}
	if err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// ErrBuilding is returned by callers that stop waiting on a build in progress.
var ErrBuilding = errors.New("still building")
