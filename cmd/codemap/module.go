package main

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/blatessa/codemap/internal/cli"
	"github.com/blatessa/codemap/internal/graph"
)

func init() {
	commands["module"] = func(args []string) error { return runModule(os.Stdout, args) }
}

const moduleUsage = `module <module id | path | label> [--root DIR] [--graph FILE] [--rev worktree] [--json]`

// moduleLink is another module and the number of edges between it and this one.
type moduleLink struct {
	Module string `json:"module"`
	Label  string `json:"label"`
	Count  int    `json:"count"`
}

func runModule(w io.Writer, args []string) error {
	var c cli.Common
	fs := cli.NewFlagSet("module", moduleUsage)
	c.Register(fs)
	pos, err := cli.Parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return cli.Usage(moduleUsage)
	}
	ix, _, err := c.Load()
	if err != nil {
		return err
	}
	id, err := cli.ResolveModule(w, ix, pos[0], c.JSON)
	if err != nil {
		return err
	}
	m := ix.Module[id]

	var nodes []graph.Node
	for _, n := range ix.G.Nodes {
		if n.Module == id {
			nodes = append(nodes, n)
		}
	}
	sort.SliceStable(nodes, func(i, j int) bool {
		a, b := nodes[i], nodes[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.ID < b.ID
	})

	// Count edges crossing the module boundary. Tests are hidden from the map,
	// so their edges don't count as dependencies.
	deps, users := map[string]int{}, map[string]int{}
	for _, e := range ix.G.Edges {
		from, to := ix.Node[e.From], ix.Node[e.To]
		if from == nil || to == nil || from.Module == to.Module || from.Kind == graph.KindTest {
			continue
		}
		if from.Module == id {
			deps[to.Module]++
		}
		if to.Module == id {
			users[from.Module]++
		}
	}
	dependsOn, usedBy := links(ix, deps), links(ix, users)

	if c.JSON {
		return cli.WriteJSON(w, map[string]any{
			"module":    m,
			"nodes":     nonNil(nodes),
			"dependsOn": dependsOn,
			"usedBy":    usedBy,
		})
	}

	kv := func(k, v string) {
		if v != "" {
			fmt.Fprintf(w, "%-7s %s\n", k+":", strings.ReplaceAll(strings.TrimSpace(v), "\n", "\n        "))
		}
	}
	kv("id", m.ID)
	kv("label", m.Label)
	kv("lang", m.Lang)
	kv("path", m.Path)
	if m.External {
		kv("kind", "external")
	}
	kv("doc", m.Doc)

	fmt.Fprintf(w, "\nContains (%d):\n", len(nodes))
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, n := range nodes {
		kind := n.Kind
		if n.Entry {
			kind += ", entry"
		}
		row := "  " + n.Label + "\t" + kind
		if loc := cli.Location(n.File, n.Line); loc != "" {
			row += "\t" + loc
		}
		fmt.Fprintln(tw, row)
	}
	tw.Flush()
	writeLinks(w, "Depends on", dependsOn)
	writeLinks(w, "Used by", usedBy)
	return nil
}

func links(ix *graph.Index, counts map[string]int) []moduleLink {
	out := []moduleLink{}
	for id, n := range counts {
		out = append(out, moduleLink{Module: id, Label: cli.ModuleLabel(ix, id), Count: n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Module < out[j].Module
	})
	return out
}

func writeLinks(w io.Writer, title string, ls []moduleLink) {
	fmt.Fprintf(w, "\n%s:\n", title)
	if len(ls) == 0 {
		fmt.Fprintln(w, "  (none)")
		return
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, l := range ls {
		calls := "calls"
		if l.Count == 1 {
			calls = "call"
		}
		fmt.Fprintf(tw, "  %s\t%d %s\n", l.Label, l.Count, calls)
	}
	tw.Flush()
}
