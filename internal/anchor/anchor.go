// Package anchor re-anchors proposal items on code (PLAN.md §6). An item made
// on selected lines keeps the file, the line range, the selected text (quote)
// and the commit it was made against (rev). When the worktree has moved on,
// Resolve finds the quote again near where git says the old lines went, or
// anywhere in the file, and reports the current range. When the quote is gone
// the anchor is stale. Nothing here is stored; it's computed per request.
package anchor

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"codemap/internal/gitrev"
	"codemap/internal/graph"
	"codemap/internal/project"
)

// Anchor is where an item's code is now.
type Anchor struct {
	File  string `json:"file"`
	Lines [2]int `json:"lines"`
	Stale bool   `json:"stale,omitempty"`
}

// Resolver resolves anchors against the worktree at Root. Repo may be nil
// (outside git): then only the quote is searched for. A Resolver caches one
// git diff per rev, so use one per request.
type Resolver struct {
	Root  string
	Repo  *gitrev.Repo
	Ctx   context.Context
	diffs map[string][]graph.FileChange
	files map[string][]string
}

func (r *Resolver) changes(rev string) []graph.FileChange {
	if r.Repo == nil || rev == "" {
		return nil
	}
	if r.diffs == nil {
		r.diffs = map[string][]graph.FileChange{}
	}
	if fc, ok := r.diffs[rev]; ok {
		return fc
	}
	ctx := r.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	fc, err := r.Repo.Changes(ctx, rev, gitrev.Worktree)
	if err != nil {
		fc = nil
	}
	r.diffs[rev] = fc
	return fc
}

func (r *Resolver) lines(file string) ([]string, bool) {
	if r.files == nil {
		r.files = map[string][]string{}
	}
	if l, ok := r.files[file]; ok {
		return l, l != nil
	}
	b, err := os.ReadFile(filepath.Join(r.Root, filepath.FromSlash(file)))
	var l []string
	if err == nil {
		l = strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	}
	r.files[file] = l
	return l, l != nil
}

// Resolve returns the item's current anchor, or nil when it has no file.
func (r *Resolver) Resolve(it map[string]any) *Anchor {
	file := project.ItemStr(it, "file")
	if file == "" {
		return nil
	}
	a, b, has := project.ItemLines(it)
	quote := project.ItemStr(it, "quote")
	cur, pa, pb := file, a, b
	for _, fc := range r.changes(project.ItemStr(it, "rev")) {
		if fc.Old != file {
			continue
		}
		cur = fc.New
		if has {
			pa, pb = Shift(fc.Hunks, a), Shift(fc.Hunks, b)
		}
		break
	}
	stale := &Anchor{File: file, Lines: [2]int{a, b}, Stale: true}
	if cur == "" {
		return stale // deleted
	}
	src, ok := r.lines(cur)
	if !ok {
		if cur != file {
			stale.File = cur
		}
		return stale
	}
	if strings.TrimSpace(quote) == "" {
		if !has {
			return &Anchor{File: cur}
		}
		return &Anchor{File: cur, Lines: [2]int{pa, pb}}
	}
	if at, n := Find(src, quote, pa); at > 0 {
		return &Anchor{File: cur, Lines: [2]int{at, at + n - 1}}
	}
	return &Anchor{File: cur, Lines: [2]int{pa, pb}, Stale: true}
}

// Shift maps a line in the old file to the new one through diff hunks
// ([oldStart, oldCount, newStart, newCount], as from git diff -U0). A line
// inside a changed hunk maps to the hunk's start.
func Shift(hunks [][4]int, line int) int {
	delta := 0
	for _, h := range hunks {
		os, oc, ns, nc := h[0], h[1], h[2], h[3]
		if oc == 0 { // insertion after line os
			if os < line {
				delta += nc
			}
			continue
		}
		if os+oc-1 < line {
			delta += nc - oc
			continue
		}
		if os <= line {
			if nc == 0 {
				return max(ns, 1)
			}
			return ns + min(line-os, nc-1)
		}
	}
	return max(line+delta, 1)
}

// Find looks for the quote in src (lines, 0-based slice; results are 1-based)
// and returns the occurrence starting nearest to line `near`, with the number
// of lines it spans. Lines compare with surrounding space trimmed; a one-line
// quote may be part of a line, and a longer one may start mid-line and end
// mid-line. at is 0 when there is no match.
func Find(src []string, quote string, near int) (at, n int) {
	q := quoteLines(quote)
	if len(q) == 0 {
		return 0, 0
	}
	best := -1
	for i := 0; i+len(q) <= len(src); i++ {
		if !matchAt(src, q, i) {
			continue
		}
		if best < 0 || abs(i+1-near) < abs(best+1-near) {
			best = i
		}
	}
	if best < 0 {
		return 0, 0
	}
	return best + 1, len(q)
}

func quoteLines(s string) []string {
	ls := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	for len(ls) > 0 && strings.TrimSpace(ls[0]) == "" {
		ls = ls[1:]
	}
	for len(ls) > 0 && strings.TrimSpace(ls[len(ls)-1]) == "" {
		ls = ls[:len(ls)-1]
	}
	for i := range ls {
		ls[i] = strings.TrimSpace(ls[i])
	}
	return ls
}

func matchAt(src, q []string, i int) bool {
	if len(q) == 1 {
		return strings.Contains(strings.TrimSpace(src[i]), q[0])
	}
	for j, ql := range q {
		s := strings.TrimSpace(src[i+j])
		switch {
		case j == 0:
			if !strings.HasSuffix(s, ql) {
				return false
			}
		case j == len(q)-1:
			if !strings.HasPrefix(s, ql) {
				return false
			}
		default:
			if s != ql {
				return false
			}
		}
	}
	return true
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// Quote returns the trimmed text of lines a..b of src (1-based), for storing
// with a new item.
func Quote(src []string, a, b int) string {
	if a < 1 || a > len(src) {
		return ""
	}
	b = min(max(b, a), len(src))
	out := make([]string, 0, b-a+1)
	for _, l := range src[a-1 : b] {
		out = append(out, strings.TrimSpace(l))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// QuoteFile reads lines a..b of a file under root, trimmed.
func QuoteFile(root, file string, a, b int) string {
	r := &Resolver{Root: root}
	src, ok := r.lines(file)
	if !ok {
		return ""
	}
	return Quote(src, a, b)
}
