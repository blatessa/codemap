package graph

// Trace is the tree codemap shows below a node, in the CLI and the viewer:
// the feature's spine (support code left out, forwarding functions skipped,
// shared functions not gone into), FeatureDepth levels deep, with every row
// listing the effects it reaches through code the tree doesn't show.
func Trace(ix *Index, id string) *TreeNode {
	return Settle(Rollup(ix, Cut(Prune(ix, Features(ix, ix.Tree(id, 0))), FeatureDepth)))
}

// Prune keeps the branches of a tree that lead somewhere new: to data, a
// service, a topic, a screen or another program's API that the tree hasn't
// already shown, other than what most features reach (CommonEffects). The rest (argument parsing, lookups of
// settings, error and translation helpers) is counted on the row above, and
// rows shown higher up aren't repeated. When nothing leads anywhere, the first
// level stays, so a tree is never empty.
func Prune(ix *Index, t *TreeNode) *TreeNode {
	common := ix.CommonEffects()
	beneath := map[string][]Effect{}
	reach := func(id string) []Effect {
		if r, ok := beneath[id]; ok {
			return r
		}
		r := ix.EffectsBeneath(id)
		beneath[id] = r
		return r
	}
	// Read in code order, a branch stays when it reaches something the story
	// hasn't shown yet: repeated steps that touch the same tables fold away,
	// and every effect still appears once.
	shown := map[Effect]bool{}
	fresh := func(fs []Effect) bool {
		for _, f := range fs {
			if !common[f] && !shown[f] {
				return true
			}
		}
		return false
	}
	var walk func(t *TreeNode) *TreeNode
	walk = func(t *TreeNode) *TreeNode {
		out := *t
		out.Children = nil
		for _, c := range t.Children {
			switch {
			case c.Via != nil && c.Via.Proposed:
				out.Children = append(out.Children, walk(c)) // a proposal's sketch is always shown
			case c.Targets != nil || c.Seen:
				out.Support++
			case c.Via != nil && ix.IsEffect(c.Via):
				f := Effect{To: c.ID, Type: c.Via.Type}
				if common[f] || shown[f] {
					out.Support++
					continue
				}
				shown[f] = true
				out.Children = append(out.Children, walk(c))
			case fresh(reach(c.ID)):
				out.Children = append(out.Children, walk(c))
				for _, f := range reach(c.ID) {
					shown[f] = true // what's left of it is listed on its row
				}
			default:
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

// RoleOf is a node's fields.role, or "". A proposed node has none: a
// proposal's sketch is never support code.
func (ix *Index) RoleOf(id string) string {
	if n := ix.Node[id]; n != nil && !n.Proposed {
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
func Features(ix *Index, t *TreeNode) *TreeNode {
	// a page's own code is the page: its trace shows what that code reaches
	// (FoldScreens), unless the trace starts inside the frontend
	return features(ix, t, !OnScreen(ix.Node[t.ID]))
}

func features(ix *Index, t *TreeNode, fold bool) *TreeNode {
	out := *t
	out.Children = nil
	var add func(kids []*TreeNode, depth int)
	add = func(kids []*TreeNode, depth int) {
		for _, c := range kids {
			switch r := ix.RoleOf(c.ID); {
			case r == RolePassthrough && depth < 16:
				if c.Seen || len(c.Children) == 0 {
					out.Support++
					continue
				}
				add(c.Children, depth+1)
			case r != "" || fold && OnScreen(ix.Node[c.ID]):
				out.Support++
			case ix.Shared(c.ID):
				leaf := *c // shown, not gone into
				leaf.Children = nil
				out.Children = append(out.Children, &leaf)
			default:
				out.Children = append(out.Children, features(ix, c, fold))
			}
		}
	}
	add(t.Children, 0)
	return &out
}

// Shared reports whether a node is marked shared: widely used, with effects of
// its own (see AssignRoles).
func (ix *Index) Shared(id string) bool {
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
// cut off print "..." (see cli.WriteTree).
func Cut(t *TreeNode, depth int) *TreeNode {
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
func Settle(t *TreeNode) *TreeNode {
	shown := map[string]bool{}
	var mark func(t *TreeNode)
	mark = func(t *TreeNode) {
		if !t.Seen && t.ID != "" {
			shown[t.ID] = true
		}
		for _, c := range t.Children {
			mark(c)
		}
	}
	mark(t)
	var fix func(t *TreeNode)
	fix = func(t *TreeNode) {
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
func Rollup(ix *Index, t *TreeNode) *TreeNode {
	common := ix.CommonEffects()
	root := t
	cache := map[string][]Effect{}
	beneath := func(id string) []Effect {
		if r, ok := cache[id]; ok {
			return r
		}
		r := ix.EffectsBeneath(id)
		cache[id] = r
		return r
	}
	var walk func(t *TreeNode) map[Effect]bool
	walk = func(t *TreeNode) map[Effect]bool {
		covered := map[Effect]bool{}
		for _, c := range t.Children {
			for f := range walk(c) {
				covered[f] = true
			}
			if c.Via != nil && ix.IsEffect(c.Via) {
				covered[Effect{To: c.ID, Type: c.Via.Type}] = true
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
	// Read top to bottom, every effect is said once: where the story first
	// reaches it.
	said := map[Effect]bool{}
	var once func(t *TreeNode)
	once = func(t *TreeNode) {
		if t.Via != nil && t != root && ix.IsEffect(t.Via) {
			said[Effect{To: t.ID, Type: t.Via.Type}] = true
		}
		var keep []Effect
		for _, f := range t.Reaches {
			if !said[f] {
				keep = append(keep, f)
				said[f] = true
			}
		}
		t.Reaches = keep
		for _, c := range t.Children {
			once(c)
		}
	}
	once(t)
	return t
}

// UpTree is Index.Tree over incoming edges: what calls start, and what calls
// that, expanding each node once. External nodes are leaves.
func UpTree(ix *Index, start string, maxDepth int) *TreeNode {
	seen := map[string]bool{start: true}
	var build func(id string, depth int) []*TreeNode
	build = func(id string, depth int) []*TreeNode {
		if maxDepth > 0 && depth >= maxDepth {
			return nil
		}
		out := ix.TreeRowsUp(ix.In[id])
		for _, t := range out {
			if t.Targets != nil {
				continue
			}
			if seen[t.ID] {
				t.Seen = true
			} else {
				seen[t.ID] = true
				if n := ix.Node[t.ID]; n == nil || !n.External {
					t.Children = build(t.ID, depth+1)
				}
			}
		}
		return out
	}
	return &TreeNode{ID: start, Children: build(start, 0)}
}

// TreeIDs returns the IDs of the nodes in a tree.
func TreeIDs(t *TreeNode) []string {
	var out []string
	var walk func(t *TreeNode)
	walk = func(t *TreeNode) {
		out = append(out, t.ID)
		for _, c := range t.Children {
			walk(c)
		}
	}
	walk(t)
	return out
}
