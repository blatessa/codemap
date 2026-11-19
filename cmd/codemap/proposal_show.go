package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/blatessa/codemap/internal/cli"
	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// proposalReview is `proposal show --json`: the proposal, and what a reviewer
// would check by hand.
type proposalReview struct {
	*project.Proposal
	Problems []string `json:"problems,omitempty"`
}

// proposalShow prints a proposal the way an agent reviews it: what it changes,
// part by part with each new call; what looks wrong in the sketch; the notes,
// each with the code it is about; then the document.
func proposalShow(w io.Writer, c cli.Common, slug string) error {
	ix, proj, err := c.Load()
	if err != nil {
		return err
	}
	var p *project.Proposal
	for _, x := range proj.Proposals {
		if x.Slug == slug {
			p = x
		}
	}
	if p == nil {
		return fmt.Errorf("no proposal %q (see codemap proposal list)", slug)
	}
	r := newReviewer(ix, p, c)
	problems := r.problems()
	if c.JSON {
		return cli.WriteJSON(w, proposalReview{p, problems})
	}

	fmt.Fprintf(w, "%s\n", p.Name)
	meta := []string{p.Status}
	if p.PR != "" {
		meta = append(meta, p.PR)
	}
	if p.Updated != "" {
		meta = append(meta, "updated "+p.Updated)
	}
	if p.Base != "" {
		meta = append(meta, "base "+short(p.Base))
	}
	fmt.Fprintf(w, "%s\n", strings.Join(meta, " · "))

	r.writeChanges(w)
	if len(problems) > 0 {
		fmt.Fprintf(w, "\nCheck (%d)\n", len(problems))
		for _, s := range problems {
			fmt.Fprintf(w, "  ! %s\n", s)
		}
	}
	if len(p.Notes) > 0 {
		fmt.Fprintf(w, "\nNotes (%d)\n", len(p.Notes))
		for i, n := range p.Notes {
			r.writeNote(w, i+1, n)
		}
	}
	if body := strings.TrimSpace(p.Body); body != "" {
		fmt.Fprintf(w, "\n%s\n", body)
	}
	return nil
}

func short(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

type reviewer struct {
	ix    *graph.Index
	p     *project.Proposal
	root  string
	local bool // the code on disk is the code the graph was built from
	node  map[string]map[string]any
	mod   map[string]string
}

func newReviewer(ix *graph.Index, p *project.Proposal, c cli.Common) *reviewer {
	r := &reviewer{ix: ix, p: p, root: c.Root, local: c.Rev == "" || c.Rev == "worktree", node: map[string]map[string]any{}, mod: map[string]string{}}
	for _, n := range p.Nodes {
		r.node[str(n["id"])] = n
	}
	for _, m := range p.Modules {
		r.mod[str(m["id"])] = str(m["label"])
	}
	return r
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func (r *reviewer) known(id string) bool {
	_, mine := r.node[id]
	_, mod := r.mod[id]
	return mine || mod || r.ix.Node[id] != nil || r.ix.Module[id] != nil
}

func (r *reviewer) moduleLabel(id string) string {
	if l, ok := r.mod[id]; ok {
		return l + " (new)"
	}
	return cli.ModuleLabel(r.ix, id)
}

func lastSeg(s string) string {
	if i := strings.LastIndex(s, "/"); i >= 0 {
		return s[i+1:]
	}
	return s
}

// name reads a node as the CLI does everywhere else, including the proposal's own.
func (r *reviewer) name(id string) string {
	n, mine := r.node[id]
	if !mine {
		if r.ix.Node[id] == nil {
			if r.ix.Module[id] != nil || r.mod[id] != "" {
				return r.moduleLabel(id)
			}
			return id + " (not in the code)"
		}
		return cli.Name(r.ix, id)
	}
	kind, label := str(n["kind"]), str(n["label"])
	if kind == "" || label == "" { // a move: the real node, in another module
		if r.ix.Node[id] != nil {
			return cli.Name(r.ix, id)
		}
	}
	switch {
	case kind == "route" && str(n["method"]) != "":
		return str(n["method"]) + " " + label
	case entryKind(n) && kind != "function" && kind != "component":
		return kind + " " + label
	case kind != "function" && kind != "component" && kind != "":
		return label + " [" + kind + "]"
	}
	if m := lastSeg(strings.TrimPrefix(r.moduleID(n), "mod:")); m != "" {
		return lastSeg(r.moduleLabelOf(n)) + "." + label
	}
	return label
}

func (r *reviewer) moduleID(n map[string]any) string { return str(n["module"]) }

func (r *reviewer) moduleLabelOf(n map[string]any) string {
	return strings.TrimSuffix(r.moduleLabel(str(n["module"])), " (new)")
}

func entryKind(n map[string]any) bool { b, _ := n["entry"].(bool); return b }

// writeChanges lists the proposal's nodes by the part they land in, each with
// the calls the proposal adds from it, then calls added from existing code.
func (r *reviewer) writeChanges(w io.Writer) {
	out := map[string][]string{} // from -> its new calls
	for _, e := range r.p.Edges {
		verb := "→"
		if t := str(e["type"]); t != "" && t != "calls" {
			verb = t
		}
		line := verb + " " + r.name(str(e["to"]))
		if d := str(e["detail"]); d != "" {
			line += "  (" + d + ")"
		}
		out[str(e["from"])] = append(out[str(e["from"])], line)
	}
	byMod := map[string][]string{}
	var mods []string
	add := func(m, id string) {
		if _, ok := byMod[m]; !ok {
			mods = append(mods, m)
		}
		byMod[m] = append(byMod[m], id)
	}
	for _, m := range r.p.Modules {
		if _, ok := byMod[str(m["id"])]; !ok {
			add(str(m["id"]), "")
		}
	}
	for _, n := range r.p.Nodes {
		add(str(n["module"]), str(n["id"]))
	}
	listed := map[string]bool{}
	fmt.Fprintf(w, "\nChanges\n")
	if len(mods) == 0 && len(out) == 0 {
		fmt.Fprintf(w, "  (none: the sketch is empty)\n")
	}
	sort.SliceStable(mods, func(i, j int) bool { return r.moduleLabel(mods[i]) < r.moduleLabel(mods[j]) })
	for _, m := range mods {
		fmt.Fprintf(w, "  %s\n", r.moduleLabel(m))
		for _, id := range byMod[m] {
			if id == "" {
				continue
			}
			listed[id] = true
			mark := "+"
			if r.ix.Node[id] != nil {
				mark = "↳ moved from " + cli.ModuleLabel(r.ix, r.ix.Node[id].Module) + ":"
			}
			fmt.Fprintf(w, "    %s %s\n", mark, r.name(id))
			if d := str(r.node[id]["doc"]); d != "" {
				fmt.Fprintf(w, "        %s\n", d)
			}
			for _, l := range out[id] {
				fmt.Fprintf(w, "        %s\n", l)
			}
		}
	}
	var gains []string
	for from := range out {
		if !listed[from] {
			gains = append(gains, from)
		}
	}
	sort.Strings(gains)
	if len(gains) > 0 {
		fmt.Fprintf(w, "  existing code that gains calls\n")
		for _, id := range gains {
			fmt.Fprintf(w, "    %s\n", r.name(id))
			for _, l := range out[id] {
				fmt.Fprintf(w, "        %s\n", l)
			}
		}
	}
}

// problems are the things a sketch gets wrong by accident.
func (r *reviewer) problems() []string {
	var out []string
	called := map[string]bool{}
	for _, e := range r.p.Edges {
		from, to := str(e["from"]), str(e["to"])
		called[to] = true
		for _, id := range []string{from, to} {
			if !r.known(id) {
				out = append(out, fmt.Sprintf("a call mentions %q, which is neither in the code nor in the proposal", id))
			}
		}
	}
	for _, n := range r.p.Nodes {
		id := str(n["id"])
		if m := str(n["module"]); m != "" && !r.known(m) {
			out = append(out, fmt.Sprintf("%s is placed in %q, which isn't a known module", r.name(id), m))
		}
		if r.ix.Node[id] == nil && !entryKind(n) && !called[id] && str(n["kind"]) != "" {
			switch str(n["kind"]) {
			case "table", "topic", "service":
			default:
				out = append(out, fmt.Sprintf("nothing calls %s: it can never run", r.name(id)))
			}
		}
	}
	for i, n := range r.p.Notes {
		if n.On != "" && !r.known(n.On) {
			out = append(out, fmt.Sprintf("note %d is about %q, which is neither in the code nor in the proposal", i+1, n.On))
		}
		if n.Text == "" {
			out = append(out, fmt.Sprintf("note %d has no text", i+1))
		}
	}
	return out
}

func (r *reviewer) writeNote(w io.Writer, i int, n project.Note) {
	var about []string
	if n.On != "" {
		about = append(about, r.name(n.On))
	}
	if n.File != "" {
		loc := n.File
		if n.From > 0 {
			loc += fmt.Sprintf(":%d", n.From)
			if n.To > n.From {
				loc += fmt.Sprintf("-%d", n.To)
			}
		}
		about = append(about, loc)
	}
	if len(about) == 0 {
		about = append(about, "the proposal")
	}
	fmt.Fprintf(w, "  %d. %s\n", i, strings.Join(about, " · "))
	if n.Quote != "" {
		for _, l := range strings.Split(strings.TrimRight(n.Quote, "\n"), "\n") {
			fmt.Fprintf(w, "     | %s\n", l)
		}
		if r.local && r.moved(n) {
			fmt.Fprintf(w, "     (the code at these lines has changed since the note was written)\n")
		}
	}
	for _, l := range strings.Split(strings.TrimSpace(n.Text), "\n") {
		fmt.Fprintf(w, "     %s\n", l)
	}
}

// moved reports whether the lines a note quotes now read differently.
func (r *reviewer) moved(n project.Note) bool {
	if n.File == "" || n.From <= 0 {
		return false
	}
	b, err := os.ReadFile(filepath.Join(r.root, filepath.FromSlash(n.File)))
	if err != nil {
		return true
	}
	lines := strings.Split(string(b), "\n")
	to := n.To
	if to < n.From {
		to = n.From
	}
	if n.From > len(lines) {
		return true
	}
	if to > len(lines) {
		to = len(lines)
	}
	norm := func(s string) string {
		var out []string
		for _, l := range strings.Split(strings.TrimRight(s, "\n"), "\n") {
			out = append(out, strings.TrimSpace(l))
		}
		return strings.Join(out, "\n")
	}
	return norm(strings.Join(lines[n.From-1:to], "\n")) != norm(n.Quote)
}
