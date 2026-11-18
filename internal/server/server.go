// Package server implements `codemap serve`: the HTTP API from PLAN.md §8, the
// embedded viewer, file watching and server-sent events.
package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing/fstest"
	"time"

	"codemap/internal/build"
	"codemap/internal/gitrev"
	"codemap/internal/graph"
	"codemap/internal/project"
)

// Options configures a Server.
type Options struct {
	// Root is the repo root. Required.
	Root string
	// GraphFile, if set, is read instead of running the extractors (see build.Options).
	GraphFile string
	// Assets is the viewer's static files, served at "/" with an SPA fallback to
	// index.html. If it has no index.html but has dist/index.html, dist/ is used.
	// Nil serves a small placeholder page.
	Assets fs.FS
	// Addr is the address the server listens on. A specific non-loopback IP is
	// added to the allowed Host values; loopback names are always allowed.
	Addr string
	// Debounce is the watcher's quiet period. Zero means 300ms.
	Debounce time.Duration
	// Logger receives rebuild errors and similar. Nil uses log.Default().
	Logger *log.Logger
}

// Server holds the cached graph and project state and serves the API.
type Server struct {
	root      string
	graphFile string
	assets    fs.FS
	debounce  time.Duration
	log       *log.Logger
	hosts     map[string]bool

	mu       sync.RWMutex
	graph    *graph.Graph
	graphRaw []byte // graph.Encode output, cached per build
	proj     *project.Project
	versions map[string]string

	writeMu sync.Mutex // serialises writes to .codemap/

	events broker

	// startCmd launches the editor; tests replace it.
	startCmd func(*exec.Cmd) error
	repo     *gitrev.Repo // nil outside a git repository

	// gitHead returns HEAD's sha, or "" outside a git repo; tests may replace it.
	gitHead func() string
}

// Missing is the version of a file that does not exist.
const Missing = "missing"

// version is a short hash of a file's bytes.
func version(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// New loads the repo and returns a server serving it. It fails if the initial
// build fails (for example build.ErrNoExtractors without a GraphFile).
func New(opt Options) (*Server, error) {
	root, err := filepath.Abs(opt.Root)
	if err != nil {
		return nil, err
	}
	if fi, err := os.Stat(root); err != nil {
		return nil, err
	} else if !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", root)
	}
	if opt.GraphFile != "" {
		if opt.GraphFile, err = filepath.Abs(opt.GraphFile); err != nil {
			return nil, err
		}
	}
	s := &Server{
		root:      root,
		graphFile: opt.GraphFile,
		assets:    opt.Assets,
		debounce:  opt.Debounce,
		log:       opt.Logger,
		hosts:     map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true},
		startCmd:  startDetached,
	}
	s.gitHead = s.defaultGitHead
	if s.debounce == 0 {
		s.debounce = 300 * time.Millisecond
	}
	if s.log == nil {
		s.log = log.Default()
	}
	if s.assets != nil {
		if _, err := fs.Stat(s.assets, "index.html"); err != nil {
			if sub, err := fs.Sub(s.assets, "dist"); err == nil {
				if _, err := fs.Stat(sub, "index.html"); err == nil {
					s.assets = sub
				}
			}
		}
	}
	if host := addrHost(opt.Addr); host != "" {
		if ip := net.ParseIP(host); ip == nil || !ip.IsUnspecified() {
			s.hosts[strings.ToLower(host)] = true
		}
	}
	if err := s.rebuildGraph(); err != nil {
		return nil, err
	}
	if err := s.reloadProject(); err != nil {
		return nil, err
	}
	if repo, err := gitrev.Open(root); err == nil {
		repo.Progress = s.onBuild
		s.repo = repo
	}
	return s, nil
}

// Close removes the temporary worktrees used to build revisions.
func (s *Server) Close() {
	if s.repo != nil {
		s.repo.Close()
	}
}

func addrHost(addr string) string {
	if h, _, err := net.SplitHostPort(addr); err == nil {
		return h
	}
	return strings.Trim(addr, "[]")
}

// Root returns the absolute repo root.
func (s *Server) Root() string { return s.root }

// rebuildGraph builds the graph and replaces the cached one. On error the
// previous graph is kept. It uses the current .codemap/ if it loads, and the last
// good project otherwise, so a broken .codemap file doesn't block rebuilds.
func (s *Server) rebuildGraph() error {
	proj, err := project.Load(s.root)
	if err != nil {
		s.mu.RLock()
		proj = s.proj
		s.mu.RUnlock()
	}
	g, err := build.Graph(s.root, proj, build.Options{GraphFile: s.graphFile})
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := g.Encode(&buf); err != nil {
		return err
	}
	s.mu.Lock()
	s.graph, s.graphRaw = g, buf.Bytes()
	s.mu.Unlock()
	return nil
}

// reloadProject re-reads .codemap/ and replaces the cached project and versions.
// On error the previous state is kept.
func (s *Server) reloadProject() error {
	p, v, err := readProject(s.root)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.proj, s.versions = p, v
	s.mu.Unlock()
	return nil
}

// projectFiles maps the writable project keys to their file names.
var projectFiles = map[string]string{
	"areas":    "areas.toml",
	"blocks":   "blocks.toml",
	"layout":   "layout.json",
	"external": "external.toml",
}

// readProject reads .codemap/ once, so the versions match exactly the bytes that
// were parsed.
func readProject(root string) (*project.Project, map[string]string, error) {
	dir := filepath.Join(root, project.Dir)
	mfs := fstest.MapFS{}
	versions := map[string]string{}
	read := func(name string) ([]byte, bool, error) {
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		mfs[name] = &fstest.MapFile{Data: b}
		return b, true, nil
	}
	if _, _, err := read("config.toml"); err != nil {
		return nil, nil, err
	}
	for key, name := range projectFiles {
		b, ok, err := read(name)
		if err != nil {
			return nil, nil, err
		}
		versions[key] = Missing
		if ok {
			versions[key] = version(b)
		}
	}
	entries, err := os.ReadDir(filepath.Join(dir, "proposals"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		b, ok, err := read("proposals/" + e.Name())
		if err != nil {
			return nil, nil, err
		}
		if ok {
			versions["proposals/"+strings.TrimSuffix(e.Name(), ".md")] = version(b)
		}
	}
	p, err := project.LoadFS(mfs)
	if err != nil {
		return nil, nil, err
	}
	return p, versions, nil
}

// fileVersion hashes a file under .codemap/ as it is on disk now.
func (s *Server) fileVersion(name string) (string, []byte, error) {
	b, err := os.ReadFile(filepath.Join(s.root, project.Dir, filepath.FromSlash(name)))
	if errors.Is(err, fs.ErrNotExist) {
		return Missing, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	return version(b), b, nil
}

func (s *Server) defaultGitHead() string {
	out, err := exec.Command("git", "-C", s.root, "rev-parse", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func startDetached(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// Handler returns the HTTP handler with the security checks applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("PUT /api/project/{name}", s.handlePutProject)
	mux.HandleFunc("GET /api/proposals", s.handleListProposals)
	mux.HandleFunc("PUT /api/proposals/{slug}", s.handlePutProposal)
	mux.HandleFunc("DELETE /api/proposals/{slug}", s.handleDeleteProposal)
	mux.HandleFunc("GET /api/source", s.handleSource)
	mux.HandleFunc("GET /api/source/diff", s.handleSourceDiff)
	mux.HandleFunc("GET /api/revs", s.handleRevs)
	mux.HandleFunc("GET /api/diff", s.handleDiff)
	mux.HandleFunc("POST /api/open", s.handleOpen)
	mux.HandleFunc("GET /api/events", s.handleEvents)
	mux.HandleFunc("GET /", s.handleAssets)
	return s.guard(mux)
}

// guard rejects requests with a foreign Host (DNS rebinding) and writes with a
// cross-origin Origin.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.hosts[strings.ToLower(addrHost(r.Host))] {
			writeError(w, http.StatusForbidden, "host not allowed: "+r.Host)
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if o := r.Header.Get("Origin"); o != "" {
				u, err := url.Parse(o)
				if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !strings.EqualFold(u.Host, r.Host) {
					writeError(w, http.StatusForbidden, "cross-origin request rejected")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
