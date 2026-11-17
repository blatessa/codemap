package cli

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"

	"codemap/internal/graph"
)

var httpMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true,
	"HEAD": true, "OPTIONS": true, "CONNECT": true, "TRACE": true,
}

// MatchNodes returns the nodes an argument refers to, trying in order and
// stopping at the first rule that matches anything:
//
//  1. exact ID
//  2. route spec: "POST /orders", "GET /orders/{id}"
//  3. page path: "/checkout"
//  4. exact label, or exact Name as printed by the CLI ("orders.Service.Place")
//  5. case-insensitive suffix of the ID or label
//
// The result is sorted.
func MatchNodes(ix *graph.Index, arg string) []string {
	if ix.Node[arg] != nil {
		return []string{arg}
	}
	if method, path, ok := routeSpec(arg); ok {
		id := graph.RouteID(method, path)
		if ix.Node[id] != nil {
			return []string{id}
		}
		want := strings.TrimPrefix(id, "route:"+method+" ")
		if got := matchPaths(ix, graph.KindRoute, "route:"+method+" ", want); len(got) > 0 {
			return got
		}
	}
	if strings.HasPrefix(arg, "/") {
		id := graph.PageID(arg)
		if ix.Node[id] != nil {
			return []string{id}
		}
		if got := matchPaths(ix, graph.KindPage, "page:", graph.NormalizeRoutePath(arg)); len(got) > 0 {
			return got
		}
	}
	var out []string
	for _, n := range ix.G.Nodes {
		if n.Label == arg || Name(ix, n.ID) == arg {
			out = append(out, n.ID)
		}
	}
	if len(out) > 0 {
		return sorted(out)
	}
	low := strings.ToLower(arg)
	for _, n := range ix.G.Nodes {
		if strings.HasSuffix(strings.ToLower(n.ID), low) || strings.HasSuffix(strings.ToLower(n.Label), low) {
			out = append(out, n.ID)
		}
	}
	return sorted(out)
}

// routeSpec splits "POST /orders" (optionally prefixed "route:") into method and path.
func routeSpec(arg string) (method, path string, ok bool) {
	s := strings.TrimPrefix(arg, "route:")
	method, path, ok = strings.Cut(strings.TrimSpace(s), " ")
	method = strings.ToUpper(method)
	path = strings.TrimSpace(path)
	if !ok || !httpMethods[method] || !strings.HasPrefix(path, "/") {
		return "", "", false
	}
	return method, path, true
}

// matchPaths finds nodes of kind whose ID is prefix + a path matching want.
func matchPaths(ix *graph.Index, kind, prefix, want string) []string {
	var out []string
	for _, n := range ix.G.Nodes {
		if n.Kind != kind || !strings.HasPrefix(n.ID, prefix) {
			continue
		}
		if graph.RouteMatch(want, strings.TrimPrefix(n.ID, prefix)) {
			out = append(out, n.ID)
		}
	}
	return sorted(out)
}

// ResolveNode resolves arg to exactly one node ID. When several nodes match, it
// prints them to w (one per line with kind and module, or as JSON) and returns
// an exit-status-2 error.
func ResolveNode(w io.Writer, ix *graph.Index, arg string, asJSON bool) (string, error) {
	ids := MatchNodes(ix, arg)
	switch len(ids) {
	case 0:
		return "", fmt.Errorf("no node matches %q (try codemap search)", arg)
	case 1:
		return ids[0], nil
	}
	type match struct {
		ID     string `json:"id"`
		Kind   string `json:"kind"`
		Module string `json:"module"`
	}
	var ms []match
	for _, id := range ids {
		n := ix.Node[id]
		ms = append(ms, match{id, n.Kind, n.Module})
	}
	if asJSON {
		if err := WriteJSON(w, map[string]any{"ambiguous": arg, "matches": ms}); err != nil {
			return "", err
		}
	} else {
		tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
		for _, m := range ms {
			fmt.Fprintf(tw, "%s\t%s\t%s\n", m.ID, m.Kind, ModuleLabel(ix, m.Module))
		}
		tw.Flush()
	}
	return "", &ExitError{Code: 2, Err: fmt.Errorf("%q matches %d nodes; pass one of the IDs above", arg, len(ids))}
}

// MatchModules returns the modules an argument refers to: exact ID, then exact
// path or label, then a case-insensitive suffix of the ID, path or label.
func MatchModules(ix *graph.Index, arg string) []string {
	if ix.Module[arg] != nil {
		return []string{arg}
	}
	arg = strings.TrimSuffix(arg, "/")
	var out []string
	for _, m := range ix.G.Modules {
		if m.Path == arg || m.Label == arg {
			out = append(out, m.ID)
		}
	}
	if len(out) > 0 {
		return sorted(out)
	}
	low := strings.ToLower(arg)
	for _, m := range ix.G.Modules {
		for _, s := range []string{m.ID, m.Path, m.Label} {
			if s != "" && strings.HasSuffix(strings.ToLower(s), low) {
				out = append(out, m.ID)
				break
			}
		}
	}
	return sorted(out)
}

// ResolveModule is ResolveNode for modules.
func ResolveModule(w io.Writer, ix *graph.Index, arg string, asJSON bool) (string, error) {
	ids := MatchModules(ix, arg)
	switch len(ids) {
	case 0:
		return "", fmt.Errorf("no module matches %q", arg)
	case 1:
		return ids[0], nil
	}
	if asJSON {
		if err := WriteJSON(w, map[string]any{"ambiguous": arg, "matches": ids}); err != nil {
			return "", err
		}
	} else {
		tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
		for _, id := range ids {
			fmt.Fprintf(tw, "%s\tmodule\t%s\n", id, ModuleLabel(ix, id))
		}
		tw.Flush()
	}
	return "", &ExitError{Code: 2, Err: fmt.Errorf("%q matches %d modules; pass one of the IDs above", arg, len(ids))}
}

func sorted(s []string) []string {
	sort.Strings(s)
	return s
}
