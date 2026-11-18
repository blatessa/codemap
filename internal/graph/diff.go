package graph

import (
	"sort"
)

// FileChange is one file's entry in `git diff -U0 -M`: its path on each side
// ("" when added or deleted) and the line ranges its hunks cover on each side.
type FileChange struct {
	Old      string   `json:"old,omitempty"`
	New      string   `json:"new,omitempty"`
	OldHunks [][2]int `json:"-"` // [first, last] lines in the old file
	NewHunks [][2]int `json:"-"` // [first, last] lines in the new file
}

// GraphDiff is what changed between two graphs (PLAN.md §7).
type GraphDiff struct {
	From string `json:"from"`
	To   string `json:"to"`

	AddedNodes   []Node   `json:"addedNodes"`
	RemovedNodes []Node   `json:"removedNodes"` // from the "from" graph, so they can be drawn
	Changed      []string `json:"changed"`      // IDs in the "to" graph whose body changed
	Renamed      []Rename `json:"renamed"`      // same node, new ID (its file was renamed)

	AddedEdges   []Edge `json:"addedEdges"`
	RemovedEdges []Edge `json:"removedEdges"`

	AddedModules   []Module `json:"addedModules"`
	RemovedModules []Module `json:"removedModules"`

	Files   []FileChange `json:"files"`
	Summary Summary      `json:"summary"`
}

// Rename pairs a node's ID in the "from" graph with its ID in the "to" graph.
type Rename struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Summary is the part of a diff worth reading first.
type Summary struct {
	EntriesAdded    []Ref       `json:"entriesAdded"`
	EntriesRemoved  []Ref       `json:"entriesRemoved"`
	DataAdded       []DataRef   `json:"dataAdded"`   // tables (or anything) newly read or written
	DataRemoved     []DataRef   `json:"dataRemoved"` // no longer read or written
	ExternalAdded   []Ref       `json:"externalAdded"`
	ExternalRemoved []Ref       `json:"externalRemoved"`
	DepsAdded       []Dep       `json:"depsAdded"`
	DepsRemoved     []Dep       `json:"depsRemoved"`
	Modules         []ModCounts `json:"modules"` // modules with any node added, removed or changed
}

// Ref names a node.
type Ref struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Label  string `json:"label"`
	Module string `json:"module"`
}

// DataRef is a node that gained or lost a reads or writes edge type.
type DataRef struct {
	Ref
	Type string   `json:"type"` // reads | writes
	By   []string `json:"by"`   // the nodes doing it (on the side where it exists)
}

// Dep is a module-to-module dependency.
type Dep struct {
	From      string `json:"from"`
	To        string `json:"to"`
	FromLabel string `json:"fromLabel"`
	ToLabel   string `json:"toLabel"`
}

// ModCounts counts changed nodes in one module.
type ModCounts struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Changed int    `json:"changed"`
}

// Empty reports whether nothing changed.
func (d *GraphDiff) Empty() bool {
	return len(d.AddedNodes)+len(d.RemovedNodes)+len(d.Changed)+len(d.AddedEdges)+len(d.RemovedEdges)+len(d.AddedModules)+len(d.RemovedModules) == 0
}

func overlaps(hunks [][2]int, from, to int) bool {
	if from <= 0 {
		return false
	}
	if to < from {
		to = from
	}
	for _, h := range hunks {
		if h[0] <= to && h[1] >= from {
			return true
		}
	}
	return false
}

// Diff compares graph a (from) with b (to). A node present in both is changed
// when a hunk overlaps its line range in either revision; lines that only moved
// do not count. Nodes whose file was renamed are matched by kind and label.
func Diff(a, b *Graph, files []FileChange) *GraphDiff {
	d := &GraphDiff{From: a.Rev, To: b.Rev, Files: files}
	an, bn := map[string]*Node{}, map[string]*Node{}
	for i := range a.Nodes {
		an[a.Nodes[i].ID] = &a.Nodes[i]
	}
	for i := range b.Nodes {
		bn[b.Nodes[i].ID] = &b.Nodes[i]
	}
	byOld, byNew := map[string]*FileChange{}, map[string]*FileChange{}
	for i := range files {
		f := &files[i]
		if f.Old != "" {
			byOld[f.Old] = f
		}
		if f.New != "" {
			byNew[f.New] = f
		}
	}
	bodyChanged := func(x, y *Node) bool {
		if f := byOld[x.File]; f != nil && overlaps(f.OldHunks, x.Line, x.EndLine) {
			return true
		}
		if f := byNew[y.File]; f != nil && overlaps(f.NewHunks, y.Line, y.EndLine) {
			return true
		}
		return false
	}

	// renames: removed nodes in a renamed file matched to added nodes by kind+label
	type key struct{ file, kind, label string }
	added := map[key]*Node{}
	for i := range b.Nodes {
		n := &b.Nodes[i]
		if an[n.ID] == nil && n.File != "" {
			added[key{n.File, n.Kind, n.Label}] = n
		}
	}
	renamedA, renamedB := map[string]bool{}, map[string]bool{}
	for i := range a.Nodes {
		x := &a.Nodes[i]
		if bn[x.ID] != nil || x.File == "" {
			continue
		}
		f := byOld[x.File]
		if f == nil || f.New == "" || f.New == f.Old {
			continue
		}
		y := added[key{f.New, x.Kind, x.Label}]
		if y == nil || renamedB[y.ID] {
			continue
		}
		renamedA[x.ID], renamedB[y.ID] = true, true
		d.Renamed = append(d.Renamed, Rename{From: x.ID, To: y.ID})
		if bodyChanged(x, y) {
			d.Changed = append(d.Changed, y.ID)
		}
	}

	for i := range b.Nodes {
		y := &b.Nodes[i]
		x := an[y.ID]
		switch {
		case renamedB[y.ID]:
		case x == nil:
			d.AddedNodes = append(d.AddedNodes, *y)
		case bodyChanged(x, y):
			d.Changed = append(d.Changed, y.ID)
		}
	}
	for i := range a.Nodes {
		if x := &a.Nodes[i]; bn[x.ID] == nil && !renamedA[x.ID] {
			d.RemovedNodes = append(d.RemovedNodes, *x)
		}
	}

	// edges, with renamed endpoints mapped to their new IDs
	ren := map[string]string{}
	for _, r := range d.Renamed {
		ren[r.From] = r.To
	}
	mapID := func(id string) string {
		if t, ok := ren[id]; ok {
			return t
		}
		return id
	}
	ekey := func(e Edge, m func(string) string) string { return m(e.From) + "\x00" + m(e.To) + "\x00" + e.Type }
	ae, be := map[string]bool{}, map[string]bool{}
	for _, e := range a.Edges {
		ae[ekey(e, mapID)] = true
	}
	same := func(s string) string { return s }
	for _, e := range b.Edges {
		be[ekey(e, same)] = true
		if !ae[ekey(e, same)] {
			d.AddedEdges = append(d.AddedEdges, e)
		}
	}
	for _, e := range a.Edges {
		if !be[ekey(e, mapID)] {
			d.RemovedEdges = append(d.RemovedEdges, e)
		}
	}

	am, bm := map[string]*Module{}, map[string]*Module{}
	for i := range a.Modules {
		am[a.Modules[i].ID] = &a.Modules[i]
	}
	for i := range b.Modules {
		bm[b.Modules[i].ID] = &b.Modules[i]
		if am[b.Modules[i].ID] == nil {
			d.AddedModules = append(d.AddedModules, b.Modules[i])
		}
	}
	for i := range a.Modules {
		if bm[a.Modules[i].ID] == nil {
			d.RemovedModules = append(d.RemovedModules, a.Modules[i])
		}
	}

	d.Summary = summarize(a, b, an, bn, am, bm, d, mapID)
	d.sort()
	return d
}

func ref(n *Node) Ref { return Ref{ID: n.ID, Kind: n.Kind, Label: n.Label, Module: n.Module} }

func summarize(a, b *Graph, an, bn map[string]*Node, am, bm map[string]*Module, d *GraphDiff, mapID func(string) string) Summary {
	var s Summary
	for i := range d.AddedNodes {
		n := &d.AddedNodes[i]
		if n.Entry {
			s.EntriesAdded = append(s.EntriesAdded, ref(n))
		}
		if n.External {
			s.ExternalAdded = append(s.ExternalAdded, ref(n))
		}
	}
	for i := range d.RemovedNodes {
		n := &d.RemovedNodes[i]
		if n.Entry {
			s.EntriesRemoved = append(s.EntriesRemoved, ref(n))
		}
		if n.External {
			s.ExternalRemoved = append(s.ExternalRemoved, ref(n))
		}
	}

	// data access: (target, type) pairs on each side
	type dk struct{ to, typ string }
	access := func(g *Graph, m func(string) string) map[dk][]string {
		out := map[dk][]string{}
		for _, e := range g.Edges {
			if e.Type == Reads || e.Type == Writes {
				k := dk{m(e.To), e.Type}
				out[k] = append(out[k], m(e.From))
			}
		}
		return out
	}
	same := func(s string) string { return s }
	aa, ba := access(a, mapID), access(b, same)
	for k, by := range ba {
		if _, ok := aa[k]; !ok {
			if n := bn[k.to]; n != nil {
				s.DataAdded = append(s.DataAdded, DataRef{Ref: ref(n), Type: k.typ, By: uniq(by)})
			}
		}
	}
	for k, by := range aa {
		if _, ok := ba[k]; !ok {
			n := bn[k.to]
			if n == nil {
				n = an[k.to]
			}
			if n != nil {
				s.DataRemoved = append(s.DataRemoved, DataRef{Ref: ref(n), Type: k.typ, By: uniq(by)})
			}
		}
	}

	// module dependencies
	deps := func(g *Graph, nodes map[string]*Node) map[[2]string]bool {
		out := map[[2]string]bool{}
		for _, e := range g.Edges {
			f, t := nodes[e.From], nodes[e.To]
			if f == nil || t == nil || f.Module == t.Module || f.Kind == KindTest {
				continue
			}
			out[[2]string{f.Module, t.Module}] = true
		}
		return out
	}
	label := func(id string) string {
		if m := bm[id]; m != nil {
			return m.Label
		}
		if m := am[id]; m != nil {
			return m.Label
		}
		return id
	}
	ad, bd := deps(a, an), deps(b, bn)
	for k := range bd {
		if !ad[k] {
			s.DepsAdded = append(s.DepsAdded, Dep{From: k[0], To: k[1], FromLabel: label(k[0]), ToLabel: label(k[1])})
		}
	}
	for k := range ad {
		if !bd[k] {
			s.DepsRemoved = append(s.DepsRemoved, Dep{From: k[0], To: k[1], FromLabel: label(k[0]), ToLabel: label(k[1])})
		}
	}

	counts := map[string]*ModCounts{}
	at := func(mod string) *ModCounts {
		c := counts[mod]
		if c == nil {
			c = &ModCounts{ID: mod, Label: label(mod)}
			counts[mod] = c
		}
		return c
	}
	for _, n := range d.AddedNodes {
		at(n.Module).Added++
	}
	for _, n := range d.RemovedNodes {
		at(n.Module).Removed++
	}
	for _, id := range d.Changed {
		if n := bn[id]; n != nil {
			at(n.Module).Changed++
		}
	}
	for _, c := range counts {
		s.Modules = append(s.Modules, *c)
	}
	return s
}

func uniq(xs []string) []string {
	m := map[string]bool{}
	out := []string{}
	for _, x := range xs {
		if !m[x] {
			m[x] = true
			out = append(out, x)
		}
	}
	sort.Strings(out)
	return out
}

func sortRefs(r []Ref) { sort.Slice(r, func(i, j int) bool { return r[i].ID < r[j].ID }) }

func (d *GraphDiff) sort() {
	sn := func(n []Node) { sort.Slice(n, func(i, j int) bool { return n[i].ID < n[j].ID }) }
	se := func(e []Edge) { sort.Slice(e, func(i, j int) bool { return e[i].key() < e[j].key() }) }
	sm := func(m []Module) { sort.Slice(m, func(i, j int) bool { return m[i].ID < m[j].ID }) }
	sn(d.AddedNodes)
	sn(d.RemovedNodes)
	sort.Strings(d.Changed)
	se(d.AddedEdges)
	se(d.RemovedEdges)
	sm(d.AddedModules)
	sm(d.RemovedModules)
	s := &d.Summary
	sortRefs(s.EntriesAdded)
	sortRefs(s.EntriesRemoved)
	sortRefs(s.ExternalAdded)
	sortRefs(s.ExternalRemoved)
	sd := func(x []DataRef) {
		sort.Slice(x, func(i, j int) bool {
			if x[i].ID != x[j].ID {
				return x[i].ID < x[j].ID
			}
			return x[i].Type < x[j].Type
		})
	}
	sd(s.DataAdded)
	sd(s.DataRemoved)
	sp := func(x []Dep) {
		sort.Slice(x, func(i, j int) bool { return x[i].From+"\x00"+x[i].To < x[j].From+"\x00"+x[j].To })
	}
	sp(s.DepsAdded)
	sp(s.DepsRemoved)
	sort.Slice(s.Modules, func(i, j int) bool { return s.Modules[i].ID < s.Modules[j].ID })
	// JSON: empty lists, not null
	for _, p := range []*[]Ref{&s.EntriesAdded, &s.EntriesRemoved, &s.ExternalAdded, &s.ExternalRemoved} {
		if *p == nil {
			*p = []Ref{}
		}
	}
	for _, p := range []*[]DataRef{&s.DataAdded, &s.DataRemoved} {
		if *p == nil {
			*p = []DataRef{}
		}
	}
	for _, p := range []*[]Dep{&s.DepsAdded, &s.DepsRemoved} {
		if *p == nil {
			*p = []Dep{}
		}
	}
	if s.Modules == nil {
		s.Modules = []ModCounts{}
	}
	for _, p := range []*[]Node{&d.AddedNodes, &d.RemovedNodes} {
		if *p == nil {
			*p = []Node{}
		}
	}
	for _, p := range []*[]Edge{&d.AddedEdges, &d.RemovedEdges} {
		if *p == nil {
			*p = []Edge{}
		}
	}
	for _, p := range []*[]Module{&d.AddedModules, &d.RemovedModules} {
		if *p == nil {
			*p = []Module{}
		}
	}
	if d.Changed == nil {
		d.Changed = []string{}
	}
	if d.Renamed == nil {
		d.Renamed = []Rename{}
	}
	if d.Files == nil {
		d.Files = []FileChange{}
	}
}
