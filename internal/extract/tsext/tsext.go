// Package tsext runs codemap's TypeScript extractor (PLAN.md §5.2). The extractor
// is a Node program, built from extractor-ts/ and embedded here as a gzipped
// bundle; it is written to the user cache dir and run with the system `node`.
package tsext

//go:generate sh -c "cd ../../../extractor-ts && npm ci && npm run build"

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"codemap/internal/graph"
	"codemap/internal/project"
)

//go:embed extractor.js.gz
var bundle []byte

// Warn reports non-fatal problems: no node, no TypeScript roots, tsconfig
// errors. Replace it to route warnings elsewhere.
var Warn = func(msg string) { fmt.Fprintln(os.Stderr, "codemap: ts:", msg) }

// Node is the node binary to run. Empty means "node" from PATH.
var Node = ""

// extractorConfig is what the Node program reads from --config.
type extractorConfig struct {
	Roots           []string `json:"roots,omitempty"`
	ModuleDepth     int      `json:"module_depth,omitempty"`
	HTTPClients     []string `json:"http_clients,omitempty"`
	BaseURLPrefixes []string `json:"base_url_prefixes,omitempty"`
	Exclude         []string `json:"exclude,omitempty"`
}

// Extract builds the partial graph for the TypeScript code in the repo at root.
// It has the build.Extractor signature. With no TypeScript roots, or no node
// binary, it returns an empty graph and reports why through Warn.
func Extract(root string, cfg project.Config) (*graph.Graph, error) {
	empty := &graph.Graph{Version: graph.Version}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if len(cfg.TS.Roots) == 0 && !hasTSConfig(abs) {
		Warn("no TypeScript roots (no ts.roots in config and no tsconfig.json found); skipping")
		return empty, nil
	}
	node := Node
	if node == "" {
		node, err = exec.LookPath("node")
		if err != nil {
			Warn("node is not installed, so TypeScript code is not mapped; install Node.js to include it")
			return empty, nil
		}
	}
	script, err := bundlePath()
	if err != nil {
		return nil, fmt.Errorf("ts extractor: %w", err)
	}
	conf, err := json.Marshal(extractorConfig{
		Roots:           cfg.TS.Roots,
		ModuleDepth:     cfg.TS.ModuleDepth,
		HTTPClients:     cfg.TS.HTTPClients,
		BaseURLPrefixes: cfg.TS.BaseURLPrefixes,
		Exclude:         cfg.Exclude,
	})
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(node, "--max-old-space-size=8192", script, "--root", abs, "--config", string(conf))
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	runErr := cmd.Run()
	var other []string
	sc := bufio.NewScanner(&stderr)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		if w, ok := strings.CutPrefix(sc.Text(), "warning: "); ok {
			Warn(w)
		} else if sc.Text() != "" {
			other = append(other, sc.Text())
		}
	}
	if runErr != nil {
		return nil, fmt.Errorf("ts extractor: %v: %s", runErr, tail(other, 20))
	}
	g, err := graph.Decode(&stdout)
	if err != nil {
		return nil, fmt.Errorf("ts extractor: decoding output: %w", err)
	}
	normalize(g)
	return g, nil
}

// normalize re-applies the Go ID normalisation to route and page IDs so they
// match the Go extractor's byte for byte.
func normalize(g *graph.Graph) {
	fix := func(id string) string {
		if m, p, ok := graph.SplitRouteID(id); ok {
			return graph.RouteID(m, p)
		}
		if p, ok := strings.CutPrefix(id, "page:"); ok {
			return graph.PageID(p)
		}
		return id
	}
	for i := range g.Nodes {
		g.Nodes[i].ID = fix(g.Nodes[i].ID)
	}
	for i := range g.Edges {
		g.Edges[i].From = fix(g.Edges[i].From)
		g.Edges[i].To = fix(g.Edges[i].To)
	}
}

func tail(lines []string, n int) string {
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

var skipDirs = map[string]bool{"node_modules": true, "dist": true, "build": true, "out": true, "coverage": true, "vendor": true}

// hasTSConfig reports whether any directory under root has a tsconfig.json.
func hasTSConfig(root string) bool {
	found := errors.New("found")
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && p != root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
			return filepath.SkipDir
		}
		if !d.IsDir() && d.Name() == "tsconfig.json" {
			return found
		}
		return nil
	})
	return err == found
}

var (
	bundleOnce sync.Once
	bundleFile string
	bundleErr  error
)

// bundlePath writes the embedded extractor to the cache dir once per version.
func bundlePath() (string, error) {
	bundleOnce.Do(func() {
		sum := sha256.Sum256(bundle)
		dir, err := os.UserCacheDir()
		if err != nil {
			dir = os.TempDir()
		}
		dir = filepath.Join(dir, "codemap")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			bundleErr = err
			return
		}
		file := filepath.Join(dir, "tsext-"+hex.EncodeToString(sum[:8])+".cjs")
		if _, err := os.Stat(file); err == nil {
			bundleFile = file
			return
		}
		zr, err := gzip.NewReader(bytes.NewReader(bundle))
		if err != nil {
			bundleErr = err
			return
		}
		js, err := io.ReadAll(zr)
		if err != nil {
			bundleErr = err
			return
		}
		tmp, err := os.CreateTemp(dir, "tsext-*.tmp")
		if err != nil {
			bundleErr = err
			return
		}
		_, werr := tmp.Write(js)
		cerr := tmp.Close()
		if werr != nil || cerr != nil {
			os.Remove(tmp.Name())
			bundleErr = errors.Join(werr, cerr)
			return
		}
		if err := os.Rename(tmp.Name(), file); err != nil {
			os.Remove(tmp.Name())
			bundleErr = err
			return
		}
		bundleFile = file
	})
	return bundleFile, bundleErr
}
