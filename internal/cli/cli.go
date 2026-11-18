// Package cli holds the helpers shared by codemap's query commands: flag
// parsing, graph loading, node and module resolution, and plain-text formatting.
// Output is meant for people and for coding agents, so it is compact and stable.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/blatessa/codemap/internal/build"
	"github.com/blatessa/codemap/internal/gitrev"
	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// ExitError ends the command with a specific exit status. Err, if set, is
// printed to stderr; a nil Err means the message has already been printed.
type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string {
	if e.Err == nil {
		return ""
	}
	return e.Err.Error()
}

func (e *ExitError) Unwrap() error { return e.Err }

// Report prints err (unless it is an ExitError that has nothing to say) and
// returns the exit status to use: an ExitError's code, otherwise 1.
func Report(w io.Writer, err error) int {
	if err == nil {
		return 0
	}
	code := 1
	var ee *ExitError
	if errors.As(err, &ee) {
		code = ee.Code
	}
	if msg := err.Error(); msg != "" {
		fmt.Fprintln(w, "codemap:", msg)
	}
	return code
}

// Parse parses args with fs, allowing flags before, between and after
// positional arguments. Everything after a bare "--" is positional.
func Parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var tail []string
	for i, a := range args {
		if a == "--" {
			tail = args[i+1:]
			args = args[:i]
			break
		}
	}
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, &ExitError{Code: 0}
			}
			return nil, &ExitError{Code: 2} // flag has printed the error and usage
		}
		args = fs.Args()
		if len(args) == 0 {
			break
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
	return append(pos, tail...), nil
}

// NewFlagSet returns a FlagSet that reports errors instead of exiting.
func NewFlagSet(name, usage string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "usage: codemap %s\n\nflags:\n", usage)
		fs.PrintDefaults()
	}
	return fs
}

// Usage returns an exit-status-2 error for wrong positional arguments.
func Usage(usage string) error {
	return &ExitError{Code: 2, Err: fmt.Errorf("usage: codemap %s", usage)}
}

// Common holds the flags every query command takes.
type Common struct {
	Root  string
	Graph string
	Rev   string
	JSON  bool
}

// Register adds the common flags to fs.
func (c *Common) Register(fs *flag.FlagSet) {
	fs.StringVar(&c.Root, "root", ".", "repository root")
	fs.StringVar(&c.Graph, "graph", "", "read this graph.json instead of running extractors")
	fs.StringVar(&c.Rev, "rev", "worktree", "revision to query: worktree, or a commit, branch or tag")
	fs.BoolVar(&c.JSON, "json", false, "machine-readable output")
}

// CheckRev rejects revisions other than the worktree, for commands that write.
func (c *Common) CheckRev() error {
	if !gitrev.IsWorktree(c.Rev) {
		return fmt.Errorf("--rev %q: this command only works on the worktree", c.Rev)
	}
	return nil
}

// Load builds the graph for the repo (at --rev) and indexes it.
func (c *Common) Load() (*graph.Index, *project.Project, error) {
	if !gitrev.IsWorktree(c.Rev) {
		if c.Graph != "" {
			return nil, nil, errors.New("--graph and --rev can't be combined")
		}
		repo, err := gitrev.Open(c.Root)
		if err != nil {
			return nil, nil, fmt.Errorf("--rev %s: %w", c.Rev, err)
		}
		defer repo.Close()
		g, p, err := repo.Build(context.Background(), c.Rev)
		if err != nil {
			return nil, nil, err
		}
		return graph.NewIndex(g), p, nil
	}
	g, p, err := build.Load(c.Root, build.Options{GraphFile: c.Graph})
	if errors.Is(err, build.ErrNoExtractors) {
		return nil, nil, errors.New("no extractors are wired in yet, so there is no graph to query; pass --graph FILE (for example --graph testdata/shop.expected.json)")
	}
	if err != nil {
		return nil, nil, err
	}
	return graph.NewIndex(g), p, nil
}

// WriteJSON writes v as indented JSON without HTML escaping.
func WriteJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
