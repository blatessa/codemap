package graph

import (
	"fmt"
	"strings"
)

// Merge combines partial graphs from several extractors into one:
//   - modules and nodes are unioned by ID; for duplicates, later non-empty scalar
//     values win and Fields are shallow-merged (later keys win);
//   - edges are deduplicated by from+to+type (the first Detail/File/Line seen is kept,
//     Declared is OR-ed);
//   - "fetches" edges to a route that doesn't exist are re-pointed at an existing route
//     whose method matches and whose path matches by RouteMatch; if none matches, a
//     placeholder route node with fields.unmatched=true is created.
func Merge(parts ...*Graph) *Graph {
	out := &Graph{Version: Version}
	modIdx := map[string]int{}
	nodeIdx := map[string]int{}
	edgeIdx := map[string]int{}

	for _, p := range parts {
		if p == nil {
			continue
		}
		if p.Rev != "" {
			out.Rev = p.Rev
		}
		for _, m := range p.Modules {
			if i, ok := modIdx[m.ID]; ok {
				out.Modules[i] = mergeModule(out.Modules[i], m)
				continue
			}
			modIdx[m.ID] = len(out.Modules)
			out.Modules = append(out.Modules, m)
		}
		for _, n := range p.Nodes {
			if i, ok := nodeIdx[n.ID]; ok {
				out.Nodes[i] = MergeNode(out.Nodes[i], n)
				continue
			}
			nodeIdx[n.ID] = len(out.Nodes)
			out.Nodes = append(out.Nodes, copyNode(n))
		}
		for _, e := range p.Edges {
			if i, ok := edgeIdx[e.key()]; ok {
				out.Edges[i].Declared = out.Edges[i].Declared || e.Declared
				continue
			}
			edgeIdx[e.key()] = len(out.Edges)
			out.Edges = append(out.Edges, e)
		}
	}

	resolveFetches(out, nodeIdx)
	return out
}

func mergeModule(a, b Module) Module {
	if b.Label != "" {
		a.Label = b.Label
	}
	if b.Lang != "" {
		a.Lang = b.Lang
	}
	if b.Path != "" {
		a.Path = b.Path
	}
	if b.Doc != "" {
		a.Doc = b.Doc
	}
	if b.Program != "" {
		a.Program = b.Program
	}
	a.External = a.External || b.External
	return a
}

// MergeNode merges b into a: non-empty scalars from b win, flags are OR-ed and
// Fields are shallow-merged.
func MergeNode(a, b Node) Node {
	a = copyNode(a)
	if b.Kind != "" {
		a.Kind = b.Kind
	}
	if b.Label != "" {
		a.Label = b.Label
	}
	if b.Module != "" {
		a.Module = b.Module
	}
	if b.File != "" {
		a.File, a.Line, a.EndLine = b.File, b.Line, b.EndLine
	}
	if b.Doc != "" {
		a.Doc = b.Doc
	}
	a.Entry = a.Entry || b.Entry
	a.External = a.External || b.External
	if len(b.Fields) > 0 {
		if a.Fields == nil {
			a.Fields = map[string]any{}
		}
		for k, v := range b.Fields {
			a.Fields[k] = v
		}
	}
	return a
}

func copyNode(n Node) Node {
	if n.Fields != nil {
		f := make(map[string]any, len(n.Fields))
		for k, v := range n.Fields {
			f[k] = v
		}
		n.Fields = f
	}
	return n
}

func resolveFetches(g *Graph, nodeIdx map[string]int) {
	type route struct{ method, path, id string }
	var routes []route
	for _, n := range g.Nodes {
		if m, p, ok := SplitRouteID(n.ID); ok {
			if f, _ := n.Fields["unmatched"].(bool); f {
				continue
			}
			routes = append(routes, route{m, p, n.ID})
		}
	}
	seen := map[string]bool{}
	for _, e := range g.Edges {
		seen[e.key()] = true
	}
	kept := g.Edges[:0]
	for _, e := range g.Edges {
		if e.Type != Fetches {
			kept = append(kept, e)
			continue
		}
		if _, ok := nodeIdx[e.To]; ok {
			kept = append(kept, e)
			continue
		}
		method, path, ok := SplitRouteID(e.To)
		if !ok {
			kept = append(kept, e)
			continue
		}
		target := ""
		for _, r := range routes {
			if r.method == method && RouteMatch(r.path, path) {
				target = r.id
				break
			}
		}
		if target == "" {
			nodeIdx[e.To] = len(g.Nodes)
			g.Nodes = append(g.Nodes, Node{
				ID: e.To, Kind: KindRoute, Label: path, Module: "mod:unmatched",
				Entry: true, Fields: map[string]any{"method": method, "unmatched": true},
			})
			ensureModule(g, Module{ID: "mod:unmatched", Label: "unmatched routes"})
			kept = append(kept, e)
			continue
		}
		e.To = target
		if seen[e.key()] {
			continue
		}
		seen[e.key()] = true
		kept = append(kept, e)
	}
	g.Edges = kept
}

func ensureModule(g *Graph, m Module) {
	for _, x := range g.Modules {
		if x.ID == m.ID {
			return
		}
	}
	g.Modules = append(g.Modules, m)
}

// SplitRouteID splits "route:POST /orders/:id" into method and path.
func SplitRouteID(id string) (method, path string, ok bool) {
	rest, found := strings.CutPrefix(id, "route:")
	if !found {
		return "", "", false
	}
	method, path, ok = strings.Cut(rest, " ")
	return method, path, ok
}

// Validate reports structural problems: duplicate IDs, nodes in unknown modules,
// and edges whose endpoints don't exist.
func Validate(g *Graph) []error {
	var errs []error
	mods := map[string]bool{}
	for _, m := range g.Modules {
		if m.ID == "" {
			errs = append(errs, fmt.Errorf("module with empty id"))
		}
		if mods[m.ID] {
			errs = append(errs, fmt.Errorf("duplicate module %q", m.ID))
		}
		mods[m.ID] = true
	}
	nodes := map[string]bool{}
	for _, n := range g.Nodes {
		switch {
		case n.ID == "":
			errs = append(errs, fmt.Errorf("node with empty id"))
		case n.Kind == "" || n.Label == "":
			errs = append(errs, fmt.Errorf("node %q is missing kind or label", n.ID))
		case !mods[n.Module]:
			errs = append(errs, fmt.Errorf("node %q is in unknown module %q", n.ID, n.Module))
		}
		if nodes[n.ID] {
			errs = append(errs, fmt.Errorf("duplicate node %q", n.ID))
		}
		nodes[n.ID] = true
	}
	for _, e := range g.Edges {
		if !nodes[e.From] {
			errs = append(errs, fmt.Errorf("edge %s -> %s: unknown from", e.From, e.To))
		}
		if !nodes[e.To] {
			errs = append(errs, fmt.Errorf("edge %s -> %s: unknown to", e.From, e.To))
		}
		if e.Type == "" {
			errs = append(errs, fmt.Errorf("edge %s -> %s: empty type", e.From, e.To))
		}
	}
	return errs
}
