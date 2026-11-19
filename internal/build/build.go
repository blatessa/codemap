// Package build produces the merged graph for a repo: it runs the extractors,
// merges their partial graphs, and loads .codemap/.
package build

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/blatessa/codemap/internal/extract/sqlext"
	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// Version is part of the cache key for revision graphs (internal/gitrev). Bump
// it when extractor output changes in a way the binary hash would not catch.
const Version = "1"

// Extractor produces a partial graph for the repo at root.
type Extractor func(root string, cfg project.Config) (*graph.Graph, error)

// Extractors run in order. cmd/codemap registers the Go and TypeScript ones.
var Extractors []Extractor

// Options controls Load.
type Options struct {
	// GraphFile, if set, is read instead of running extractors. Useful for
	// developing the server, CLI and viewer against testdata/shop.expected.json.
	GraphFile string
}

// ErrNoExtractors is returned when there is nothing to build a graph from.
var ErrNoExtractors = errors.New("no extractors are wired in yet; pass a graph file")

// Load builds the merged graph and loads .codemap/ for the repo at root.
func Load(root string, opt Options) (*graph.Graph, *project.Project, error) {
	proj, err := project.Load(root)
	if err != nil {
		return nil, nil, err
	}
	g, err := Graph(root, proj, opt)
	if err != nil {
		return nil, nil, err
	}
	return g, proj, nil
}

// Graph builds the merged graph using an already-loaded project (its config and
// external.toml). Callers that keep the last good project, like the server, use
// this so a broken .codemap file doesn't block graph rebuilds.
func Graph(root string, proj *project.Project, opt Options) (*graph.Graph, error) {
	if proj == nil {
		proj = &project.Project{}
	}
	var parts []*graph.Graph
	if opt.GraphFile != "" {
		f, err := os.Open(opt.GraphFile)
		if err != nil {
			return nil, err
		}
		g, err := graph.Decode(f)
		f.Close()
		if err != nil {
			return nil, fmt.Errorf("%s: %w", opt.GraphFile, err)
		}
		parts = append(parts, g)
	} else {
		if len(Extractors) == 0 {
			return nil, ErrNoExtractors
		}
		for _, x := range Extractors {
			g, err := x(root, proj.Config)
			if err != nil {
				return nil, err
			}
			parts = append(parts, g)
		}
	}
	g := graph.Merge(parts...)
	if g.Rev == "" {
		g.Rev = "worktree"
	}
	graph.AssignRoles(g, func(file string) ([]byte, error) {
		return os.ReadFile(filepath.Join(root, filepath.FromSlash(file)))
	})
	graph.FoldScreens(g, screenFiles(proj.Config.TS.Screens))
	Programs(g, func(file string) ([]byte, error) {
		return os.ReadFile(filepath.Join(root, filepath.FromSlash(file)))
	})
	return g, nil
}

// screenFiles matches the files configured as screens; nil leaves screens to
// graph.FoldScreens' defaults.
func screenFiles(globs []string) func(file string) bool {
	if len(globs) == 0 {
		return nil
	}
	return func(file string) bool { return sqlext.Excluded(file, globs) }
}
