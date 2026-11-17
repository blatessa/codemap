package goext

import (
	"strings"

	"codemap/internal/graph"
)

// builder accumulates a partial graph: modules and nodes by ID (first one wins),
// edges by from+to+type with the earliest call site and every distinct detail.
type builder struct {
	modules map[string]graph.Module
	nodes   map[string]*graph.Node
	edges   map[[3]string]*edgeAcc
}

type edgeAcc struct {
	e       graph.Edge
	details []string
}

func newBuilder() *builder {
	return &builder{
		modules: map[string]graph.Module{},
		nodes:   map[string]*graph.Node{},
		edges:   map[[3]string]*edgeAcc{},
	}
}

func (b *builder) addModule(m graph.Module) {
	if _, ok := b.modules[m.ID]; !ok {
		b.modules[m.ID] = m
	}
}

// addNode adds n unless a node with its ID exists, and returns the stored node.
func (b *builder) addNode(n graph.Node) *graph.Node {
	if old, ok := b.nodes[n.ID]; ok {
		return old
	}
	b.nodes[n.ID] = &n
	return &n
}

func (b *builder) has(id string) bool { _, ok := b.nodes[id]; return ok }

func (b *builder) addEdge(e graph.Edge) {
	if e.From == e.To {
		return
	}
	k := [3]string{e.From, e.To, e.Type}
	acc, ok := b.edges[k]
	if !ok {
		acc = &edgeAcc{e: e}
		acc.e.Detail = ""
		b.edges[k] = acc
	} else if e.File != "" && (acc.e.File == "" || e.File < acc.e.File || e.File == acc.e.File && e.Line < acc.e.Line) {
		acc.e.File, acc.e.Line = e.File, e.Line
	}
	if e.Detail != "" {
		for _, d := range acc.details {
			if d == e.Detail {
				return
			}
		}
		acc.details = append(acc.details, e.Detail)
	}
}

// graph returns the accumulated graph, dropping edges whose endpoints don't exist.
func (b *builder) graph() *graph.Graph {
	g := &graph.Graph{Version: graph.Version}
	for _, m := range b.modules {
		g.Modules = append(g.Modules, m)
	}
	for _, n := range b.nodes {
		g.Nodes = append(g.Nodes, *n)
	}
	for _, acc := range b.edges {
		if !b.has(acc.e.From) || !b.has(acc.e.To) {
			continue
		}
		e := acc.e
		e.Detail = strings.Join(acc.details, "; ")
		g.Edges = append(g.Edges, e)
	}
	g.Sort()
	return g
}
