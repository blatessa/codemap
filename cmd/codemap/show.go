package main

import (
	"fmt"
	"io"
	"os"

	"github.com/blatessa/codemap/internal/cli"
	"github.com/blatessa/codemap/internal/graph"
)

func init() {
	commands["show"] = func(args []string) error { return runShow(os.Stdout, args) }
}

const showUsage = `show <node> [--root DIR] [--graph FILE] [--rev worktree] [--json]`

func runShow(w io.Writer, args []string) error {
	var c cli.Common
	fs := cli.NewFlagSet("show", showUsage)
	c.Register(fs)
	pos, err := cli.Parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return cli.Usage(showUsage)
	}
	ix, _, err := c.Load()
	if err != nil {
		return err
	}
	id, err := cli.ResolveNode(w, ix, pos[0], c.JSON)
	if err != nil {
		return err
	}
	n := ix.Node[id]
	tree := cli.Trace(ix, id)

	// Entry points show the tests along the path shown; other nodes show the
	// tests that reach them (as the viewer's details panel does).
	var reachedBy []string
	var tests []graph.TestReach
	if n.Entry {
		var onPath []string
		for _, t := range cli.TreeIDs(tree) {
			// shared functions are on every path; their tests aren't this one's
			if tn := ix.Node[t]; tn != nil && !tn.External && !cli.Shared(ix, t) {
				onPath = append(onPath, t)
			}
		}
		tests = ix.TestsReaching(onPath...)
	} else {
		reachedBy = ix.EntriesReaching(id)
		tests = ix.TestsReaching(id)
	}

	if c.JSON {
		return cli.WriteJSON(w, map[string]any{
			"node":      n,
			"tree":      tree,
			"reachedBy": nonNil(reachedBy),
			"tests":     nonNil(tests),
		})
	}
	cli.WriteHeader(w, ix, id)
	fmt.Fprintln(w)
	cli.WriteTree(w, ix, tree, cli.TreeOptions{})
	if !n.Entry {
		fmt.Fprintln(w)
		fmt.Fprintln(w, "Reached by:")
		if len(reachedBy) == 0 {
			fmt.Fprintln(w, "  (no entry points)")
		}
		for _, e := range reachedBy {
			fmt.Fprintln(w, "  "+cli.Name(ix, e))
		}
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Tests:")
	writeTests(w, ix, tests)
	return nil
}

func writeTests(w io.Writer, ix *graph.Index, tests []graph.TestReach) {
	if len(tests) == 0 {
		fmt.Fprintln(w, "  (none)")
		return
	}
	for _, t := range tests {
		row := "  " + t.Test
		if tn := ix.Node[t.Test]; tn != nil {
			if loc := cli.Location(tn.File, tn.Line); loc != "" {
				row += "  " + loc
			}
		}
		if t.Direct {
			row += "  (direct)"
		} else if t.Via != "" {
			row += "  via " + cli.Name(ix, t.Via)
		}
		fmt.Fprintln(w, row)
	}
}

// nonNil turns a nil slice into an empty one so JSON output shows [] not null.
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
