package main

import (
	"fmt"
	"io"
	"os"

	"github.com/blatessa/codemap/internal/cli"
)

func init() {
	commands["callers"] = func(args []string) error { return runCallers(os.Stdout, args) }
}

const callersUsage = `callers <node> [--depth N] [--detail features|code] [--root DIR] [--graph FILE] [--rev worktree] [--json]`

func runCallers(w io.Writer, args []string) error {
	var c cli.Common
	fs := cli.NewFlagSet("callers", callersUsage)
	c.Register(fs)
	depth := fs.Int("depth", 0, "limit the tree to N levels (0 = no limit)")
	detail := cli.DetailFlag(fs)
	pos, err := cli.Parse(fs, args)
	if err != nil {
		return err
	}
	level, err := detail()
	if err != nil {
		return &cli.ExitError{Code: 2, Err: err}
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
	tree := cli.UpTree(ix, id, *depth)
	if level == cli.DetailFeatures {
		tree = cli.Settle(cli.Features(ix, tree))
	}
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
