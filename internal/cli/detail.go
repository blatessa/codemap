package cli

import (
	"github.com/blatessa/codemap/internal/graph"
)

// Trace is the tree codemap shows below a node, in the CLI and the viewer:
// the feature's spine (support code left out, forwarding functions skipped,
// shared functions not gone into), FeatureDepth levels deep, with every row
// listing the effects it reaches through code the tree doesn't show.
func Trace(ix *graph.Index, id string) *graph.TreeNode {
	return Settle(Rollup(ix, Cut(Prune(ix, Features(ix, ix.Tree(id, 0))), FeatureDepth)))
}

// Prune keeps the branches of a tree that lead somewhere: to data, a service,
// a topic, a screen or another program's API, other than what most features
// reach (graph.CommonEffects). The rest (argument parsing, lookups of
// settings, error and translation helpers) is counted on the row above, and
// rows shown higher up aren't repeated. When nothing leads anywhere, the first
// level stays, so a tree is never empty.
func Prune(ix *graph.Index, t *graph.TreeNode) *graph.TreeNode {
	common := ix.CommonEffects()
	beneath := map[string]bool{}
	distinct := func(id string) bool {
		if v, ok := beneath[id]; ok {
			return v
		}
		v := false
		for _, f := range ix.EffectsBeneath(id) {
			if !common[f] {
				v = true
				break
			}
		}
		beneath[id] = v
		return v
	}
	memo := map[*graph.TreeNode]bool{}
	var leads func(c *graph.TreeNode) bool
	leads = func(c *graph.TreeNode) bool {
		if v, ok := memo[c]; ok {
			return v
		}
		v := false
		switch {
		case c.Targets != nil || c.Seen:
		case c.Via != nil && ix.IsEffect(c.Via):
			v = !common[graph.Effect{To: c.ID, Type: c.Via.Type}]
		case len(c.Children) == 0:
			v = distinct(c.ID) // a shared function, or a leaf: what it does itself
		default:
			for _, k := range c.Children {
				if leads(k) {
					v = true
				}
			}
		}
		memo[c] = v
		return v
	}
	var walk func(t *graph.TreeNode) *graph.TreeNode
	walk = func(t *graph.TreeNode) *graph.TreeNode {
		out := *t
		out.Children = nil
		for _, c := range t.Children {
			if leads(c) {
				out.Children = append(out.Children, walk(c))
			} else {
				out.Support++
			}
		}
		return &out
	}
	res := walk(t)
	if len(res.Children) == 0 && len(t.Children) > 0 {
		res.Support = t.Support
		for _, c := range t.Children {
			if c.Seen {
				res.Support++
				continue
			}
			leaf := *c
			leaf.Children = nil
			res.Children = append(res.Children, &leaf)
		}
	}
	return res
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

// FeatureDepth is how many levels a trace shows. Deeper code is summarised by
// the effects it reaches (Rollup); show a row on its own to see inside it.
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

// Rollup sets each row's Reaches: the effects reachable below it that its
// shown subtree doesn't already show, as an effect row or another row's
// Reaches. A row shown higher up ("see above") covers its own effects there.
// It changes t in place and returns it.
func Rollup(ix *graph.Index, t *graph.TreeNode) *graph.TreeNode {
	common := ix.CommonEffects()
	root := t
	cache := map[string][]graph.Effect{}
	beneath := func(id string) []graph.Effect {
		if r, ok := cache[id]; ok {
			return r
		}
		r := ix.EffectsBeneath(id)
		cache[id] = r
		return r
	}
	var walk func(t *graph.TreeNode) map[graph.Effect]bool
	walk = func(t *graph.TreeNode) map[graph.Effect]bool {
		covered := map[graph.Effect]bool{}
		for _, c := range t.Children {
			for f := range walk(c) {
				covered[f] = true
			}
			if c.Via != nil && ix.IsEffect(c.Via) {
				covered[graph.Effect{To: c.ID, Type: c.Via.Type}] = true
			}
			if c.Seen {
				for _, f := range beneath(c.ID) {
					covered[f] = true
				}
			}
		}
		if t.Seen || t.ID == "" || t.Targets != nil {
			return covered
		}
		if n := ix.Node[t.ID]; n == nil || n.External {
			return covered
		}
		t.Reaches = nil
		for _, f := range beneath(t.ID) {
			if common[f] && t != root {
				continue // said once, on the root
			}
			if !covered[f] {
				t.Reaches = append(t.Reaches, f)
				covered[f] = true
			}
		}
		return covered
	}
	walk(t)
	return t
}
