package main

import (
	"fmt"
	"io"
	"os"

	"github.com/blatessa/codemap/internal/cli"
	"github.com/blatessa/codemap/internal/graph"
)

func init() {
	commands["callers"] = func(args []string) error { return runCallers(os.Stdout, args) }
}

const callersUsage = `callers <node> [--root DIR] [--graph FILE] [--rev worktree] [--json]`

func runCallers(w io.Writer, args []string) error {
	var c cli.Common
	fs := cli.NewFlagSet("callers", callersUsage)
	c.Register(fs)
	pos, err := cli.Parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return cli.Usage(callersUsage)
	}
	ix, _, err := c.Load()
	if err != nil {
		return err
	}
	id, err := cli.ResolveNode(w, ix, pos[0], c.JSON)
	if err != nil {
		return err
	}
	// Walks upstream and stops at external nodes, as Index.Up with StopAtExternalUp does.
	tree := graph.Settle(graph.Features(ix, graph.UpTree(ix, id, 0)))
	if c.JSON {
		return cli.WriteJSON(w, map[string]any{"node": ix.Node[id], "tree": tree})
	}
	cli.WriteHeader(w, ix, id)
	fmt.Fprintln(w)
	if len(tree.Children) == 0 && tree.Support == 0 {
		fmt.Fprintln(w, cli.Name(ix, id)+"  (no callers)")
		return nil
	}
	cli.WriteTree(w, ix, tree, cli.TreeOptions{Up: true})
	return nil
}
