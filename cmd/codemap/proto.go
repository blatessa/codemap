package main

// proto is a throwaway prototype (branch proto, never merged): it dumps what a
// "features and data" view of a repo would show, as one JSON file a static
// page renders. See ~/.claude/plans/structured-rolling-shore.md.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/blatessa/codemap/internal/cli"
	"github.com/blatessa/codemap/internal/gitrev"
	"github.com/blatessa/codemap/internal/graph"
)

func init() {
	commands["proto"] = func(args []string) error { return runProto(os.Stdout, args) }
}

type protoFeature struct {
	ID      string         `json:"id"`
	Kind    string         `json:"kind"`
	Name    string         `json:"name"`
	Group   []string       `json:"group"` // path for the features tree
	File    string         `json:"file,omitempty"`
	Line    int            `json:"line,omitempty"`
	Effects []graph.Effect `json:"effects"`
	Trace   []protoRow     `json:"trace"`
}

// protoRow is one trace row: depth, name, edge note, effects reached below.
type protoRow struct {
	D       int            `json:"d"`
	ID      string         `json:"id,omitempty"`
	M       string         `json:"m,omitempty"` // the node's module
	Kind    string         `json:"k,omitempty"`
	Name    string         `json:"n"`
	Note    string         `json:"note,omitempty"`
	More    bool           `json:"more,omitempty"`
	Support int            `json:"sup,omitempty"`
	Reaches []graph.Effect `json:"r,omitempty"`
}

type protoTable struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Columns [][]any  `json:"columns"`
	Refs    []string `json:"refs"` // tables this one points at
	Group   string   `json:"group"`
}

type protoExternal struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
}

type protoOut struct {
	Repo      string          `json:"repo"`
	Built     string          `json:"built"`
	Features  []protoFeature  `json:"features"`
	Tables    []protoTable    `json:"tables"`
	Externals []protoExternal `json:"externals"`
	Common    []protoCommon   `json:"common"` // code most features pass through
	Changes   *protoChanges   `json:"changes,omitempty"`
	Modules   []protoModule   `json:"modules"`
	Screens   []protoScreen   `json:"screens"`
	Stats     map[string]any  `json:"stats"`
}

// protoScreen is a template the server renders, with the partials it includes.
type protoScreen struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	File     string   `json:"file,omitempty"`
	Partials []string `json:"partials"`
}

// protoModule is a package of the repo's own code and the modules it calls.
type protoModule struct {
	ID      string         `json:"id"`
	Label   string         `json:"label"`
	Deps    []string       `json:"deps"`
	Funcs   int            `json:"funcs"`
	Effects []graph.Effect `json:"effects"` // its own functions' effects
	Inside  []protoFunc    `json:"inside"`  // its functions that aren't support code
	Calls   [][2]string    `json:"calls"`   // calls from those functions, to its own or other modules' functions
}

type protoFunc struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Pub   bool   `json:"pub,omitempty"` // called from another module
	Entry bool   `json:"entry,omitempty"`
	File  string `json:"file,omitempty"`
	Line  int    `json:"line,omitempty"`
}

type protoCommon struct {
	Name    string         `json:"name"`
	Reached int            `json:"reached"` // entry points reaching it
	Effects []graph.Effect `json:"effects"`
}

func runProto(w io.Writer, args []string) error {
	var c cli.Common
	fs := cli.NewFlagSet("proto", "proto [--root DIR] [--graph FILE] [--since REV]")
	c.Register(fs)
	since := fs.String("since", "", "also describe what changed since this revision")
	if _, err := cli.Parse(fs, args); err != nil {
		return err
	}
	t0 := time.Now()
	ix, _, err := c.Load()
	if err != nil {
		return err
	}
	loaded := time.Since(t0)
	out := buildProto(ix)
	out.Repo = c.Root
	if *since != "" {
		repo, err := gitrev.Open(c.Root)
		if err != nil {
			return err
		}
		defer repo.Close()
		ctx := context.Background()
		g, _, err := repo.Build(ctx, *since)
		if err != nil {
			return err
		}
		before := buildProto(graph.NewIndex(g))
		ch := diffProto(before, out)
		ch.Since = *since
		if commits, err := commitsSince(ctx, c.Root, *since); err == nil {
			ch.Commits = commits
		}
		out.Changes = &ch
	}
	out.Stats["load"] = loaded.Round(time.Millisecond).String()
	out.Stats["total"] = time.Since(t0).Round(time.Millisecond).String()
	return json.NewEncoder(w).Encode(out)
}

func buildProto(ix *graph.Index) protoOut {
	out := protoOut{Built: time.Now().Format(time.DateTime), Stats: map[string]any{}}

	common := commonCode(ix)
	out.Common = []protoCommon{}
	for _, id := range sortedSet(common.top) {
		out.Common = append(out.Common, protoCommon{Name: cli.Name(ix, id), Reached: common.reach[id], Effects: ix.EffectsBeneath(id)})
	}
	out.Stats["entries"] = common.entries
	for _, n := range ix.G.Nodes {
		if !n.Entry || n.Kind == graph.KindTest {
			continue
		}
		f := protoFeature{ID: n.ID, Kind: n.Kind, Name: cli.Name(ix, n.ID), Group: featureGroup(n), File: n.File, Line: n.Line}
		f.Effects = ix.EffectsBeneath(n.ID)
		if f.Effects == nil {
			f.Effects = []graph.Effect{}
		}
		f.Trace = flatTrace(ix, cli.Trace(ix, n.ID))
		out.Features = append(out.Features, f)
	}
	sort.Slice(out.Features, func(i, j int) bool { return out.Features[i].ID < out.Features[j].ID })

	for _, n := range ix.G.Nodes {
		switch n.Kind {
		case graph.KindTable:
			t := protoTable{ID: n.ID, Name: n.Label, Refs: []string{}, Columns: [][]any{}}
			if cols, ok := n.Fields["columns"].([]any); ok {
				for _, c := range cols {
					if row, ok := c.([]any); ok {
						t.Columns = append(t.Columns, row)
						if len(row) == 3 {
							if note, _ := row[2].(string); strings.HasPrefix(note, "→ ") {
								ref := strings.TrimPrefix(note, "→ ")
								ref, _, _ = strings.Cut(ref, ".")
								t.Refs = append(t.Refs, "table:"+ref)
							}
						}
					}
				}
			}
			out.Tables = append(out.Tables, t)
		case graph.KindScreen:
			sc := protoScreen{ID: n.ID, Name: n.Label, File: n.File, Partials: []string{}}
			for _, e := range ix.Out[n.ID] {
				if e.Type == graph.Renders {
					sc.Partials = append(sc.Partials, e.To)
				}
			}
			out.Screens = append(out.Screens, sc)
		case graph.KindService, graph.KindTopic:
			out.Externals = append(out.Externals, protoExternal{ID: n.ID, Kind: n.Kind, Label: n.Label})
		}
	}
	groupTables(out.Tables)
	sort.Slice(out.Tables, func(i, j int) bool { return out.Tables[i].Name < out.Tables[j].Name })
	sort.Slice(out.Externals, func(i, j int) bool { return out.Externals[i].ID < out.Externals[j].ID })

	out.Modules = moduleDeps(ix)
	out.Stats["nodes"] = len(ix.G.Nodes)
	return out
}

// moduleDeps lists the repo's code modules with the modules they call, counting
// only calls between code that isn't support (the same edges traces show).
func moduleDeps(ix *graph.Index) []protoModule {
	deps := map[string]map[string]bool{}
	funcs := map[string]int{}
	code := func(n *graph.Node) bool {
		return n != nil && !n.External && n.Kind != graph.KindTest && n.Module != ""
	}
	for _, n := range ix.G.Nodes {
		if code(&n) {
			funcs[n.Module]++
		}
	}
	for _, e := range ix.G.Edges {
		a, b := ix.Node[e.From], ix.Node[e.To]
		if e.Type != graph.Calls || !code(a) || !code(b) || a.Module == b.Module || ix.Wide(&e) {
			continue
		}
		if cli.RoleOf(ix, b.ID) != "" {
			continue
		}
		if deps[a.Module] == nil {
			deps[a.Module] = map[string]bool{}
		}
		deps[a.Module][b.Module] = true
	}
	inside := map[string][]protoFunc{}
	effs := map[string]map[graph.Effect]bool{}
	calls := map[string][][2]string{}
	for _, n := range ix.G.Nodes {
		if !code(&n) || cli.RoleOf(ix, n.ID) != "" {
			continue
		}
		f := protoFunc{ID: n.ID, Label: n.Label, Entry: n.Entry, File: n.File, Line: n.Line}
		for _, e := range ix.In[n.ID] {
			if a := ix.Node[e.From]; code(a) && a.Module != n.Module && e.Type == graph.Calls {
				f.Pub = true
				break
			}
		}
		inside[n.Module] = append(inside[n.Module], f)
		for _, e := range ix.Out[n.ID] {
			if ix.IsEffect(e) {
				if effs[n.Module] == nil {
					effs[n.Module] = map[graph.Effect]bool{}
				}
				effs[n.Module][graph.Effect{To: e.To, Type: e.Type}] = true
				calls[n.Module] = append(calls[n.Module], [2]string{n.ID, e.To})
				continue
			}
			b := ix.Node[e.To]
			if e.Type == graph.Calls && code(b) && !ix.Wide(e) && cli.RoleOf(ix, b.ID) == "" {
				calls[n.Module] = append(calls[n.Module], [2]string{n.ID, e.To})
			}
		}
	}
	var out []protoModule
	for id, n := range funcs {
		m := protoModule{ID: id, Label: id, Deps: sortedSet(deps[id]), Funcs: n, Inside: inside[id], Calls: calls[id], Effects: []graph.Effect{}}
		for e := range effs[id] {
			m.Effects = append(m.Effects, e)
		}
		sort.Slice(m.Effects, func(i, j int) bool { return m.Effects[i].Type+m.Effects[i].To < m.Effects[j].Type+m.Effects[j].To })
		if m.Inside == nil {
			m.Inside = []protoFunc{}
		}
		if mod := ix.Module[id]; mod != nil {
			m.Label = mod.Label
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

type protoChanges struct {
	Since           string          `json:"since"`
	Commits         []string        `json:"commits"`
	FeaturesAdded   []string        `json:"featuresAdded"`
	FeaturesRemoved []string        `json:"featuresRemoved"`
	Effects         []protoEffDelta `json:"effects"` // features whose effects changed
	TablesAdded     []string        `json:"tablesAdded"`
	TablesRemoved   []string        `json:"tablesRemoved"`
	Columns         []protoColDelta `json:"columns"`
	ExternalAdded   []string        `json:"externalAdded"`
	ExternalRemoved []string        `json:"externalRemoved"`
	ModulesAdded    []string        `json:"modulesAdded"`
	ModulesRemoved  []string        `json:"modulesRemoved"`
	DepsAdded       [][2]string     `json:"depsAdded"`
	DepsRemoved     [][2]string     `json:"depsRemoved"`
}

type protoEffDelta struct {
	Feature string         `json:"feature"`
	Added   []graph.Effect `json:"added"`
	Removed []graph.Effect `json:"removed"`
}

type protoColDelta struct {
	Table   string   `json:"table"`
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
}

func diffProto(a, b protoOut) protoChanges {
	ch := protoChanges{}
	fa := map[string]protoFeature{}
	for _, f := range a.Features {
		fa[f.ID] = f
	}
	fb := map[string]bool{}
	for _, f := range b.Features {
		fb[f.ID] = true
		old, ok := fa[f.ID]
		if !ok {
			ch.FeaturesAdded = append(ch.FeaturesAdded, f.ID)
			continue
		}
		set := func(es []graph.Effect) map[graph.Effect]bool {
			m := map[graph.Effect]bool{}
			for _, e := range es {
				m[e] = true
			}
			return m
		}
		was, now := set(old.Effects), set(f.Effects)
		d := protoEffDelta{Feature: f.ID}
		for e := range now {
			if !was[e] {
				d.Added = append(d.Added, e)
			}
		}
		for e := range was {
			if !now[e] {
				d.Removed = append(d.Removed, e)
			}
		}
		if len(d.Added)+len(d.Removed) > 0 {
			ch.Effects = append(ch.Effects, d)
		}
	}
	for id := range fa {
		if !fb[id] {
			ch.FeaturesRemoved = append(ch.FeaturesRemoved, id)
		}
	}
	ta := map[string]protoTable{}
	for _, t := range a.Tables {
		ta[t.ID] = t
	}
	tb := map[string]bool{}
	for _, t := range b.Tables {
		tb[t.ID] = true
		old, ok := ta[t.ID]
		if !ok {
			ch.TablesAdded = append(ch.TablesAdded, t.ID)
			continue
		}
		cols := func(t protoTable) map[string]bool {
			m := map[string]bool{}
			for _, c := range t.Columns {
				m[fmt.Sprint(c[0])] = true
			}
			return m
		}
		was, now := cols(old), cols(t)
		d := protoColDelta{Table: t.ID}
		for c := range now {
			if !was[c] {
				d.Added = append(d.Added, c)
			}
		}
		for c := range was {
			if !now[c] {
				d.Removed = append(d.Removed, c)
			}
		}
		if len(d.Added)+len(d.Removed) > 0 {
			ch.Columns = append(ch.Columns, d)
		}
	}
	for id := range ta {
		if !tb[id] {
			ch.TablesRemoved = append(ch.TablesRemoved, id)
		}
	}
	xa := map[string]bool{}
	for _, x := range a.Externals {
		xa[x.ID] = true
	}
	xb := map[string]bool{}
	for _, x := range b.Externals {
		xb[x.ID] = true
		if !xa[x.ID] {
			ch.ExternalAdded = append(ch.ExternalAdded, x.ID)
		}
	}
	for id := range xa {
		if !xb[id] {
			ch.ExternalRemoved = append(ch.ExternalRemoved, id)
		}
	}
	ma, mb := map[string]protoModule{}, map[string]protoModule{}
	for _, m := range a.Modules {
		ma[m.ID] = m
	}
	for _, m := range b.Modules {
		mb[m.ID] = m
		if _, ok := ma[m.ID]; !ok {
			ch.ModulesAdded = append(ch.ModulesAdded, m.ID)
		}
	}
	for id := range ma {
		if _, ok := mb[id]; !ok {
			ch.ModulesRemoved = append(ch.ModulesRemoved, id)
		}
	}
	pairs := func(ms map[string]protoModule) map[[2]string]bool {
		p := map[[2]string]bool{}
		for id, m := range ms {
			for _, d := range m.Deps {
				p[[2]string{id, d}] = true
			}
		}
		return p
	}
	pa, pb := pairs(ma), pairs(mb)
	for k := range pb {
		if !pa[k] {
			ch.DepsAdded = append(ch.DepsAdded, k)
		}
	}
	for k := range pa {
		if !pb[k] {
			ch.DepsRemoved = append(ch.DepsRemoved, k)
		}
	}
	less := func(l [][2]string) {
		sort.Slice(l, func(i, j int) bool { return l[i][0]+l[i][1] < l[j][0]+l[j][1] })
	}
	less(ch.DepsAdded)
	less(ch.DepsRemoved)
	for _, l := range []*[]string{&ch.ModulesAdded, &ch.ModulesRemoved, &ch.FeaturesAdded, &ch.FeaturesRemoved, &ch.TablesAdded, &ch.TablesRemoved, &ch.ExternalAdded, &ch.ExternalRemoved} {
		sort.Strings(*l)
	}
	sort.Slice(ch.Effects, func(i, j int) bool { return ch.Effects[i].Feature < ch.Effects[j].Feature })
	return ch
}

func commitsSince(ctx context.Context, root, rev string) ([]string, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", root, "log", "--format=%h %s", rev+"..HEAD").Output()
	if err != nil {
		return nil, err
	}
	var lines []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	return lines, nil
}

// featureGroup places an entry point in the features tree: routes by path
// segment, other entries by kind and the words of their name.
func featureGroup(n graph.Node) []string {
	switch n.Kind {
	case graph.KindRoute:
		segs := []string{"routes"}
		for _, s := range strings.Split(strings.Trim(n.Label, "/"), "/") {
			if s != "" {
				segs = append(segs, "/"+s)
			}
		}
		return segs[:len(segs)-min(1, len(segs)-1)] // the route's own last segment is its row
	case graph.KindPage:
		return []string{"pages"}
	}
	g := []string{n.Kind + "s"}
	if words := strings.Fields(n.Label); len(words) > 1 {
		g = append(g, words[:len(words)-1]...)
	}
	return g
}

func flatTrace(ix *graph.Index, t *graph.TreeNode) []protoRow {
	var out []protoRow
	var walk func(t *graph.TreeNode, d int)
	walk = func(t *graph.TreeNode, d int) {
		r := protoRow{D: d, Support: t.Support, Reaches: t.Reaches}
		if t.Targets != nil {
			r.Name = cli.WideName(ix, t, false)
		} else {
			r.Name = cli.Name(ix, t.ID)
			r.Note = cli.EdgeNote(ix, t.Via, t.ID)
			r.ID = t.ID
			if n := ix.Node[t.ID]; n != nil {
				r.M, r.Kind = n.Module, n.Kind
			}
		}
		if t.Seen {
			r.Note = strings.TrimSpace(r.Note + " (see above)")
		}
		r.More = d > 0 && len(t.Children) == 0 && !t.Seen && t.Targets == nil && len(ix.Out[t.ID]) > 0
		out = append(out, r)
		for _, c := range t.Children {
			walk(c, d+1)
		}
	}
	walk(t, 0)
	return out
}

// groupTables clusters tables for display: tables sharing a name prefix
// (action_run, action_task) group under it; others group with what they
// reference; the rest are "other".
func groupTables(ts []protoTable) {
	prefix := map[string]int{}
	pre := func(name string) string {
		p, _, ok := strings.Cut(name, "_")
		if !ok {
			return name
		}
		return p
	}
	for _, t := range ts {
		prefix[pre(t.Name)]++
	}
	byID := map[string]*protoTable{}
	for i := range ts {
		byID[ts[i].ID] = &ts[i]
	}
	for i := range ts {
		if p := pre(ts[i].Name); prefix[p] > 1 {
			ts[i].Group = p
		}
	}
	for i := range ts {
		if ts[i].Group != "" {
			continue
		}
		for _, r := range ts[i].Refs {
			if o := byID[r]; o != nil && o.Group != "" {
				ts[i].Group = o.Group
				break
			}
		}
		if ts[i].Group == "" {
			ts[i].Group = ts[i].Name
		}
	}
	_ = fmt.Sprint
}

type commonInfo struct {
	set     map[string]bool // functions at least half the entry points reach
	top     map[string]bool // common functions called from code that isn't common
	reach   map[string]int
	entries int
}

// follow is the traversal effects use: calls and renders that aren't wide,
// never into external nodes or tests.
func follow(ix *graph.Index, e *graph.Edge) bool {
	if e.Type != graph.Calls && e.Type != graph.Renders || ix.Wide(e) {
		return false
	}
	n := ix.Node[e.To]
	return n != nil && !n.External && n.Kind != graph.KindTest
}

// commonCode finds the code most entry points pass through: request plumbing,
// opening the database, auth. Its effects are true of every feature, so they're
// shown once instead of in every feature's row.
func commonCode(ix *graph.Index) commonInfo {
	ci := commonInfo{set: map[string]bool{}, top: map[string]bool{}, reach: map[string]int{}}
	for _, n := range ix.G.Nodes {
		if !n.Entry || n.Kind == graph.KindTest {
			continue
		}
		ci.entries++
		seen := map[string]bool{n.ID: true}
		q := []string{n.ID}
		for len(q) > 0 {
			x := q[0]
			q = q[1:]
			for _, e := range ix.Out[x] {
				if follow(ix, e) && !seen[e.To] {
					seen[e.To] = true
					ci.reach[e.To]++
					if !ix.Stop(e.To) {
						q = append(q, e.To)
					}
				}
			}
		}
	}
	min := max(3, ci.entries/2)
	for id, k := range ci.reach {
		if k >= min && !ix.Node[id].Entry {
			ci.set[id] = true
		}
	}
	for id := range ci.set {
		for _, e := range ix.In[id] {
			if !ci.set[e.From] {
				ci.top[id] = true
				break
			}
		}
	}
	return ci
}

// ownEffects is EffectsBeneath without going into common code.
func ownEffects(ix *graph.Index, id string, common map[string]bool) []graph.Effect {
	seen := map[string]bool{id: true}
	got := map[graph.Effect]bool{}
	out := []graph.Effect{}
	add := func(e *graph.Edge) {
		if f := (graph.Effect{To: e.To, Type: e.Type}); !got[f] {
			got[f] = true
			out = append(out, f)
		}
	}
	q := []string{id}
	for len(q) > 0 {
		x := q[0]
		q = q[1:]
		for _, e := range ix.Out[x] {
			if ix.IsEffect(e) {
				add(e)
				continue
			}
			if !follow(ix, e) || seen[e.To] || common[e.To] {
				continue
			}
			seen[e.To] = true
			if ix.Stop(e.To) {
				for _, f := range ix.Out[e.To] {
					if ix.StopEffect(f) {
						add(f)
					}
				}
				continue
			}
			q = append(q, e.To)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Type+out[i].To < out[j].Type+out[j].To })
	return out
}

func sortedSet(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
