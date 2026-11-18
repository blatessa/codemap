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
	"github.com/blatessa/codemap/internal/project"
)

func init() {
	commands["modules"] = func(args []string) error { return runModules(os.Stdout, args) }
}

const modulesUsage = `modules [--root DIR] [--graph FILE] [--rev worktree] [--json]`

// moduleRow is one module in the overview: enough to decide how to organise the map.
type moduleRow struct {
	ID        string       `json:"id"`
	Label     string       `json:"label"`
	External  bool         `json:"external,omitempty"`
	Functions int          `json:"functions"`
	Entries   int          `json:"entries"`
	From      string       `json:"from,omitempty"` // for a block: the module it's split from
	DependsOn []moduleLink `json:"dependsOn"`
	UsedBy    int          `json:"usedBy"` // modules that call into this one
}

// runModules prints every module with its size and dependencies, then anything
// in blocks.toml that doesn't match the code.
func runModules(w io.Writer, args []string) error {
	var c cli.Common
	fs := cli.NewFlagSet("modules", modulesUsage)
	c.Register(fs)
	pos, err := cli.Parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 0 {
		return cli.Usage(modulesUsage)
	}
	ix, proj, err := c.Load()
	if err != nil {
		return err
	}
	if proj == nil {
		proj = &project.Project{}
	}

	var problems []string
	for _, b := range proj.Blocks {
		if ix.Module[b.From] == nil {
			problems = append(problems, fmt.Sprintf("block %q splits %s, which isn't a module", b.Name, b.From))
			continue
		}
		if b.ID == "" {
			problems = append(problems, fmt.Sprintf("block %q has no id (use \"block:%s\")", b.Name, project.Slugify(b.Name)))
		}
	}

	rows := map[string]*moduleRow{}
	for _, m := range ix.G.Modules {
		rows[m.ID] = &moduleRow{ID: m.ID, Label: m.Label, External: m.External, DependsOn: []moduleLink{}}
	}
	for _, b := range proj.Blocks {
		if ix.Module[b.From] != nil && b.ID != "" {
			rows[b.ID] = &moduleRow{ID: b.ID, Label: b.Name, From: b.From, DependsOn: []moduleLink{}}
		}
	}
	// where a node is drawn: its block, if one takes it, else its module
	boxOf := func(n *graph.Node) string {
		if b := project.BlockFor(proj.Blocks, *n); b != "" && rows[b] != nil {
			return b
		}
		return n.Module
	}
	for i := range ix.G.Nodes {
		n := &ix.G.Nodes[i]
		r := rows[boxOf(n)]
		if r == nil || n.Kind == graph.KindTest {
			continue
		}
		r.Functions++
		if n.Entry {
			r.Entries++
		}
	}
	deps := map[string]map[string]int{}
	users := map[string]map[string]bool{}
	for _, e := range ix.G.Edges {
		from, to := ix.Node[e.From], ix.Node[e.To]
		if from == nil || to == nil || from.Kind == graph.KindTest {
			continue
		}
		a, b := boxOf(from), boxOf(to)
		if a == b {
			continue
		}
		if deps[a] == nil {
			deps[a] = map[string]int{}
		}
		deps[a][b]++
		if users[b] == nil {
			users[b] = map[string]bool{}
		}
		users[b][a] = true
	}
	list := make([]*moduleRow, 0, len(rows))
	for id, r := range rows {
		if r.Functions == 0 {
			continue // modules with only tests, or wholly split into blocks, don't show on the map
		}
		r.DependsOn = links(ix, deps[id])
		for i := range r.DependsOn {
			if br := rows[r.DependsOn[i].Module]; br != nil && br.From != "" {
				r.DependsOn[i].Label = br.Label
			}
		}
		r.UsedBy = len(users[id])
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })

	if c.JSON {
		return cli.WriteJSON(w, map[string]any{"modules": list, "blocks": nonNilBlocks(proj.Blocks), "problems": nonNilStrings(problems)})
	}

	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "MODULE ID\tFNS\tENTRIES\tUSED BY\tDEPENDS ON")
	for _, r := range list {
		var ds []string
		for i, d := range r.DependsOn {
			if i == 4 {
				ds = append(ds, fmt.Sprintf("+%d more", len(r.DependsOn)-4))
				break
			}
			ds = append(ds, d.Label)
		}
		label := r.ID
		if r.From != "" {
			label += " (" + r.Label + ")"
		}
		fmt.Fprintf(tw, "%s\t%d\t%d\t%d\t%s\n", label, r.Functions, r.Entries, r.UsedBy, strings.Join(ds, ", "))
	}
	tw.Flush()
	fmt.Fprintf(w, "\n%d modules.\n", len(list))
	if len(problems) > 0 {
		fmt.Fprintln(w, "\nProblems:")
		for _, p := range problems {
			fmt.Fprintln(w, "  "+p)
		}
	}
	return nil
}

func nonNilBlocks(b []project.Block) []project.Block {
	if b == nil {
		return []project.Block{}
	}
	return b
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
