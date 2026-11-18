package cli

import (
	"flag"
	"fmt"

	"codemap/internal/graph"
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
// replaced by its own children (A → passthrough → C reads A → C), and rows
// with any other role are left out and counted in their parent's Support.
// The root always stays.
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
			default:
				out.Children = append(out.Children, Features(ix, c))
			}
		}
	}
	add(t.Children, 0)
	return &out
}
