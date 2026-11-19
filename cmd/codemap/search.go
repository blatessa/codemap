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
	commands["search"] = func(args []string) error { return runSearch(os.Stdout, args) }
}

const searchUsage = `search <text> [--limit 50] [--root DIR] [--graph FILE] [--rev worktree] [--json]`

type searchHit struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
	File  string `json:"file,omitempty"`
	Line  int    `json:"line,omitempty"`
	Match string `json:"match"` // which field matched first: label, id, file or doc
	rank  int
	tier  int
}

// tierOf orders hits by what helps understand a system first: features, then
// the data and outside systems they touch, modules, functions, support code,
// tests.
func tierOf(ix *graph.Index, id string) int {
	n := ix.Node[id]
	switch {
	case n == nil:
		return 2 // a module
	case n.Kind == graph.KindTest:
		return 5
	case n.Entry:
		return 0
	case n.External:
		return 1
	case cli.RoleOf(ix, id) != "":
		return 4
	}
	return 3
}

func runSearch(w io.Writer, args []string) error {
	var c cli.Common
	fs := cli.NewFlagSet("search", searchUsage)
	c.Register(fs)
	limit := fs.Int("limit", 50, "show at most N results (0 = all)")
	pos, err := cli.Parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) == 0 {
		return cli.Usage(searchUsage)
	}
	text := strings.Join(pos, " ")
	ix, _, err := c.Load()
	if err != nil {
		return err
	}
	q := strings.ToLower(text)

	var hits []searchHit
	add := func(id, kind, label, file string, line int, doc string) {
		h := searchHit{ID: id, Kind: kind, Label: label, File: file, Line: line, rank: 3}
		switch {
		case strings.ToLower(label) == q:
			h.Match, h.rank = "label", 0
		case strings.Contains(strings.ToLower(label), q):
			h.Match, h.rank = "label", 1
		case strings.Contains(strings.ToLower(id), q):
			h.Match, h.rank = "id", 2
		case strings.Contains(strings.ToLower(file), q):
			h.Match = "file"
		case strings.Contains(strings.ToLower(doc), q):
			h.Match = "doc"
		default:
			return
		}
		h.tier = tierOf(ix, id)
		hits = append(hits, h)
	}
	for _, n := range ix.G.Nodes {
		add(n.ID, n.Kind, n.Label, n.File, n.Line, n.Doc)
	}
	for _, m := range ix.G.Modules {
		add(m.ID, "module", m.Label, m.Path, 0, m.Doc)
	}
	// an exact name first, then any name match by tier, then the rest by tier
	bucket := func(h searchHit) int { return min(h.rank, 2) }
	sort.Slice(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		if (a.rank == 0) != (b.rank == 0) {
			return a.rank == 0
		}
		if bucket(a) != bucket(b) {
			return bucket(a) < bucket(b)
		}
		if a.tier != b.tier {
			return a.tier < b.tier
		}
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		return a.ID < b.ID
	})
	total := len(hits)
	if *limit > 0 && len(hits) > *limit {
		hits = hits[:*limit]
	}

	if c.JSON {
		return cli.WriteJSON(w, nonNil(hits))
	}
	if total == 0 {
		fmt.Fprintf(w, "no matches for %q\n", text)
		return nil
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, h := range hits {
		name := h.Label
		if _, ok := ix.Node[h.ID]; ok {
			name = cli.Name(ix, h.ID)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\n", name, h.Kind, cli.Location(h.File, h.Line))
	}
	tw.Flush()
	if total > len(hits) {
		fmt.Fprintf(w, "(%d more; raise --limit)\n", total-len(hits))
	}
	return nil
}
