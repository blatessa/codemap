package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"codemap/internal/graph"
)

// Name is how a node is shown in trees and lists:
//
//	POST /orders              route (method and path)
//	page /checkout            other entry points: kind prefix
//	orders [table]            tables, topics, services, tests and other kinds: kind tag
//	orders.Service.Place      functions and components: module-qualified label
//
// Every Name resolves back to its node (see ResolveNode).
func Name(ix *graph.Index, id string) string {
	n := ix.Node[id]
	if n == nil {
		return id
	}
	switch {
	case n.Kind == graph.KindRoute && strings.HasPrefix(id, "route:"):
		return strings.TrimPrefix(id, "route:")
	case n.Entry && n.Kind != graph.KindFunction && n.Kind != graph.KindComponent:
		return n.Kind + " " + n.Label
	case n.Kind != graph.KindFunction && n.Kind != graph.KindComponent:
		return n.Label + " [" + n.Kind + "]"
	}
	if m := ShortModule(ix, n.Module); m != "" {
		return m + "." + n.Label
	}
	return n.Label
}

// ShortModule is the last path segment of a module's label ("internal/orders" -> "orders").
func ShortModule(ix *graph.Index, id string) string {
	label := id
	if m := ix.Module[id]; m != nil {
		label = m.Label
	} else if id == "" {
		return ""
	}
	if i := strings.LastIndex(label, "/"); i >= 0 {
		label = label[i+1:]
	}
	return label
}

// ModuleLabel returns a module's label, or its ID if it isn't in the graph.
func ModuleLabel(ix *graph.Index, id string) string {
	if m := ix.Module[id]; m != nil && m.Label != "" {
		return m.Label
	}
	return id
}

// Location is "file:line", "file", or "".
func Location(file string, line int) string {
	if file == "" {
		return ""
	}
	if line > 0 {
		return fmt.Sprintf("%s:%d", file, line)
	}
	return file
}

// EdgeNote describes the edge into a tree row: its type (unless it is a plain
// call) and its detail (SQL, HTTP method and path, SDK method), unless the
// detail just repeats the node's name.
func EdgeNote(ix *graph.Index, e *graph.Edge, rowID string) string {
	if e == nil {
		return ""
	}
	detail := e.Detail
	if n := ix.Node[rowID]; n != nil && (detail == n.Label || detail == Name(ix, rowID)) {
		detail = ""
	}
	typ := e.Type
	if typ == graph.Calls {
		typ = ""
	}
	switch {
	case typ != "" && detail != "":
		return typ + ": " + detail
	case typ != "":
		return typ
	default:
		return detail
	}
}

// WriteHeader prints a node's ID, kind, module, location, doc and fields as
// "key: value" lines.
func WriteHeader(w io.Writer, ix *graph.Index, id string) {
	n := ix.Node[id]
	kv := func(k, v string) {
		if v == "" {
			return
		}
		v = strings.ReplaceAll(strings.TrimSpace(v), "\n", "\n        ")
		fmt.Fprintf(w, "%-7s %s\n", k+":", v)
	}
	kv("id", id)
	if n == nil {
		return
	}
	kind := n.Kind
	var flags []string
	if n.Entry {
		flags = append(flags, "entry")
	}
	if n.External {
		flags = append(flags, "external")
	}
	if len(flags) > 0 {
		kind += " (" + strings.Join(flags, ", ") + ")"
	}
	kv("kind", kind)
	kv("module", ModuleLabel(ix, n.Module))
	kv("file", Location(n.File, n.Line))
	kv("doc", n.Doc)
	keys := make([]string, 0, len(n.Fields))
	for k := range n.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		kv(k, fieldText(n.Fields[k]))
	}
}

func fieldText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// TreeOptions controls WriteTree.
type TreeOptions struct {
	// Up means the tree was built from incoming edges, so a row's Via edge
	// points from the row to its parent.
	Up bool
}

// WriteTree prints a call tree with two spaces of indent per level. A row that
// was already expanded higher up ends in "(see above)"; a row whose children
// were cut off by a depth limit ends in "...".
func WriteTree(w io.Writer, ix *graph.Index, t *graph.TreeNode, opt TreeOptions) {
	var walk func(t *graph.TreeNode, depth int)
	walk = func(t *graph.TreeNode, depth int) {
		row := strings.Repeat("  ", depth) + Name(ix, t.ID)
		if note := EdgeNote(ix, t.Via, t.ID); note != "" {
			row += "  " + note
		}
		if t.Seen {
			row += "  (see above)"
		} else if depth > 0 && len(t.Children) == 0 && hasMore(ix, t.ID, opt.Up) {
			row += "  ..."
		}
		fmt.Fprintln(w, row)
		for _, c := range t.Children {
			walk(c, depth+1)
		}
	}
	walk(t, 0)
}

func hasMore(ix *graph.Index, id string, up bool) bool {
	if n := ix.Node[id]; n != nil && n.External {
		return false
	}
	if up {
		return len(ix.In[id]) > 0
	}
	return len(ix.Out[id]) > 0
}

// UpTree is Index.Tree over incoming edges: what calls start, and what calls
// that, expanding each node once. External nodes are leaves.
func UpTree(ix *graph.Index, start string, maxDepth int) *graph.TreeNode {
	seen := map[string]bool{start: true}
	var build func(id string, depth int) []*graph.TreeNode
	build = func(id string, depth int) []*graph.TreeNode {
		if maxDepth > 0 && depth >= maxDepth {
			return nil
		}
		var out []*graph.TreeNode
		for _, e := range ix.In[id] {
			t := &graph.TreeNode{ID: e.From, Via: e}
			if seen[e.From] {
				t.Seen = true
			} else {
				seen[e.From] = true
				if n := ix.Node[e.From]; n == nil || !n.External {
					t.Children = build(e.From, depth+1)
				}
			}
			out = append(out, t)
		}
		return out
	}
	return &graph.TreeNode{ID: start, Children: build(start, 0)}
}

// TreeIDs returns the IDs of the nodes in a tree.
func TreeIDs(t *graph.TreeNode) []string {
	var out []string
	var walk func(t *graph.TreeNode)
	walk = func(t *graph.TreeNode) {
		out = append(out, t.ID)
		for _, c := range t.Children {
			walk(c)
		}
	}
	walk(t)
	return out
}
