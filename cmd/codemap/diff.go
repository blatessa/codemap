package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/blatessa/codemap/internal/build"
	"github.com/blatessa/codemap/internal/cli"
	"github.com/blatessa/codemap/internal/gitrev"
	"github.com/blatessa/codemap/internal/graph"
)

func init() {
	commands["diff"] = func(args []string) error { return runDiff(os.Stdout, args) }
}

const diffUsage = `diff [FROM..TO | FROM...TO | REV | pr:N] [--root DIR] [--json]`

// runDiff prints what changed in the architecture between two revisions. The
// default is HEAD..worktree (uncommitted changes). FROM...TO starts at the
// merge-base, like git diff.
func runDiff(w io.Writer, args []string) error {
	fs := cli.NewFlagSet("diff", diffUsage)
	root := fs.String("root", ".", "repository root")
	asJSON := fs.Bool("json", false, "machine-readable output")
	pos, err := cli.Parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) > 1 {
		return cli.Usage(diffUsage)
	}
	spec := ""
	if len(pos) == 1 {
		spec = pos[0]
	}
	repo, err := gitrev.Open(*root)
	if err != nil {
		return fmt.Errorf("diff: %w", err)
	}
	defer repo.Close()
	ctx := context.Background()
	from, to := gitrev.ParseRange(spec)
	rg, err := repo.ResolveRange(ctx, from, to)
	if err != nil {
		return err
	}
	d, err := repo.Diff(ctx, rg, func() (*graph.Graph, error) {
		g, _, err := build.Load(repo.Root, build.Options{})
		return g, err
	})
	if err != nil {
		return err
	}
	if *asJSON {
		return cli.WriteJSON(w, d)
	}
	writeDiff(w, d, from, to)
	return nil
}

func shortRev(sha string) string {
	if len(sha) > 7 && sha != gitrev.Worktree {
		return sha[:7]
	}
	return sha
}

func writeDiff(w io.Writer, d *graph.GraphDiff, from, to string) {
	label := func(rev, sha string) string {
		if rev == "" || rev == sha || strings.HasPrefix(sha, rev) || rev == gitrev.Worktree {
			return shortRev(sha)
		}
		return rev + " (" + shortRev(sha) + ")"
	}
	fmt.Fprintf(w, "%s → %s\n", label(from, d.From), label(to, d.To))
	if d.Empty() {
		fmt.Fprintln(w, "no architectural changes")
		return
	}
	s := d.Summary
	section := func(title string, lines []string) {
		if len(lines) == 0 {
			return
		}
		fmt.Fprintf(w, "\n%s\n", title)
		for _, l := range lines {
			fmt.Fprintln(w, "  "+l)
		}
	}
	refs := func(sign string, rs []graph.Ref) []string {
		var out []string
		for _, r := range rs {
			l := r.Label
			if r.Method != "" {
				l = r.Method + " " + l
			}
			out = append(out, fmt.Sprintf("%s %s  [%s]", sign, l, r.Kind))
		}
		return out
	}
	section("entry points", append(refs("+", s.EntriesAdded), refs("-", s.EntriesRemoved)...))
	data := func(sign string, xs []graph.DataRef) []string {
		var out []string
		for _, x := range xs {
			out = append(out, fmt.Sprintf("%s %s %s  by %s", sign, x.Type, x.Label, strings.Join(x.By, ", ")))
		}
		return out
	}
	section("data", append(data("+", s.DataAdded), data("-", s.DataRemoved)...))
	section("external", append(refs("+", s.ExternalAdded), refs("-", s.ExternalRemoved)...))
	deps := func(sign string, xs []graph.Dep) []string {
		var out []string
		for _, x := range xs {
			out = append(out, fmt.Sprintf("%s %s → %s", sign, x.FromLabel, x.ToLabel))
		}
		return out
	}
	section("module deps", append(deps("+", s.DepsAdded), deps("-", s.DepsRemoved)...))
	var mods []string
	for _, m := range s.Modules {
		var parts []string
		if m.Added > 0 {
			parts = append(parts, fmt.Sprintf("+%d", m.Added))
		}
		if m.Removed > 0 {
			parts = append(parts, fmt.Sprintf("-%d", m.Removed))
		}
		if m.Changed > 0 {
			parts = append(parts, fmt.Sprintf("~%d", m.Changed))
		}
		mods = append(mods, fmt.Sprintf("%-28s %s", m.Label, strings.Join(parts, " ")))
	}
	section("modules", mods)

	where := func(n graph.Node) string {
		if n.File == "" {
			return ""
		}
		return fmt.Sprintf("  %s:%d", n.File, n.Line)
	}
	var nodes []string
	for _, n := range d.AddedNodes {
		nodes = append(nodes, "+ "+n.Label+where(n))
	}
	for _, n := range d.RemovedNodes {
		nodes = append(nodes, "- "+n.Label+where(n))
	}
	for _, id := range d.Changed {
		nodes = append(nodes, "~ "+id)
	}
	section("nodes", nodes)
	if n := len(d.AddedEdges) + len(d.RemovedEdges); n > 0 {
		fmt.Fprintf(w, "\nedges  +%d -%d\n", len(d.AddedEdges), len(d.RemovedEdges))
	}
}
