package cli

import (
	"flag"
	"fmt"

	"github.com/blatessa/codemap/internal/graph"
)

// Detail levels for trees, as in the viewer: features shows a feature's spine,
// code shows everything.
const (
	DetailFeatures = "features"
	DetailCode     = "code"
)

// DetailFlag registers --detail and returns a function that validates it.
func DetailFlag(fs *flag.FlagSet) func() (string, error) {
	d := fs.String("detail", DetailFeatures, "features (skip support code) or code (everything)")
	return func() (string, error) {
		if *d != DetailFeatures && *d != DetailCode {
			return "", fmt.Errorf("--detail %q: want features or code", *d)
		}
		return *d, nil
	}
}

// RoleOf is a node's fields.role, or "".
func RoleOf(ix *graph.Index, id string) string {
	if n := ix.Node[id]; n != nil {
		s, _ := n.Fields["role"].(string)
		return s
	}
	return ""
}

// Features rewrites a tree for the features detail level: a passthrough row is
// replaced by its own children (A → passthrough → C reads A → C), rows with
// any other role are left out and counted in their parent's Support, and a
// shared function (widely used, with effects of its own or one call away) is
// shown without what it calls. The root always stays.
func Features(ix *graph.Index, t *graph.TreeNode) *graph.TreeNode {
	out := *t
	out.Children = nil
	var add func(kids []*graph.TreeNode, depth int)
	add = func(kids []*graph.TreeNode, depth int) {
		for _, c := range kids {
			switch r := RoleOf(ix, c.ID); {
			case r == graph.RolePassthrough && depth < 16:
				if c.Seen || len(c.Children) == 0 {
					out.Support++
					continue
				}
				add(c.Children, depth+1)
			case r != "":
				out.Support++
			case Shared(ix, c.ID):
				leaf := *c // shown, not gone into
				leaf.Children = nil
				out.Children = append(out.Children, &leaf)
			default:
				out.Children = append(out.Children, Features(ix, c))
			}
		}
	}
	add(t.Children, 0)
	return &out
}

// Shared reports whether a node is marked shared: widely used, with effects of
// its own (see graph.AssignRoles).
func Shared(ix *graph.Index, id string) bool {
	if n := ix.Node[id]; n != nil {
		b, _ := n.Fields["shared"].(bool)
		return b
	}
	return false
}

// FeatureDepth is how many levels a features tree shows unless asked for more.
const FeatureDepth = 4

// Cut limits a tree to depth levels below its root; 0 means no limit. Rows
// cut off print "..." (see WriteTree).
func Cut(t *graph.TreeNode, depth int) *graph.TreeNode {
	if depth <= 0 {
		return t
	}
	out := *t
	out.Children = nil
	for _, c := range t.Children {
		if depth == 1 {
			leaf := *c
			leaf.Children = nil
			out.Children = append(out.Children, &leaf)
		} else {
			out.Children = append(out.Children, Cut(c, depth-1))
		}
	}
	return &out
}

// Settle clears "see above" on rows whose expanded copy is no longer in the
// tree (cut by a depth limit, or left out with support code), so no row
// points at nothing. It changes t in place and returns it.
func Settle(t *graph.TreeNode) *graph.TreeNode {
	shown := map[string]bool{}
	var mark func(t *graph.TreeNode)
	mark = func(t *graph.TreeNode) {
		if !t.Seen && t.ID != "" {
			shown[t.ID] = true
		}
		for _, c := range t.Children {
			mark(c)
		}
	}
	mark(t)
	var fix func(t *graph.TreeNode)
	fix = func(t *graph.TreeNode) {
		if t.Seen && !shown[t.ID] {
			t.Seen = false
			shown[t.ID] = true
		}
		for _, c := range t.Children {
			fix(c)
		}
	}
	fix(t)
	return t
}
