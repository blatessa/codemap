package gitrev

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"codemap/internal/graph"
)

// Range is a resolved comparison: From is a commit sha, To is a sha or "worktree".
type Range struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// ParseRange splits "a..b", "a...b" (from the merge-base of a and b), "pr:N"
// or a single rev "a" (meaning a..worktree) into from and to revs.
func ParseRange(spec string) (from, to string) {
	if spec == "" {
		return "HEAD", Worktree
	}
	if strings.HasPrefix(spec, "pr:") {
		return spec, ""
	}
	if a, b, ok := strings.Cut(spec, "..."); ok {
		if b == "" {
			b = Worktree
		}
		return "base:" + a, b
	}
	if a, b, ok := strings.Cut(spec, ".."); ok {
		if a == "" {
			a = "HEAD"
		}
		if b == "" {
			b = Worktree
		}
		return a, b
	}
	return spec, Worktree
}

// ResolveRange resolves from and to. "pr:N" as from (with to empty, the same
// or the worktree) means the PR's merge-base to its head. "base:<rev>" means
// the merge-base of <rev> and to.
func (r *Repo) ResolveRange(ctx context.Context, from, to string) (Range, error) {
	if n, ok := prNumber(from); ok && (to == "" || to == from || IsWorktree(to)) {
		base, head, err := r.ResolvePR(ctx, n)
		return Range{base, head}, err
	}
	var rg Range
	switch n, isPR := prNumber(to); {
	case IsWorktree(to):
		rg.To = Worktree
	case isPR:
		_, head, err := r.ResolvePR(ctx, n)
		if err != nil {
			return rg, err
		}
		rg.To = head
	default:
		sha, err := r.Resolve(ctx, to)
		if err != nil {
			return rg, err
		}
		rg.To = sha
	}
	if b, ok := strings.CutPrefix(from, "base:"); ok {
		sha, err := r.MergeBase(ctx, b, rg.To)
		rg.From = sha
		return rg, err
	}
	if IsWorktree(from) {
		return rg, errors.New("from cannot be the worktree")
	}
	sha, err := r.Resolve(ctx, from)
	rg.From = sha
	return rg, err
}

func prNumber(rev string) (int, bool) {
	s, ok := strings.CutPrefix(rev, "pr:")
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(s, "#"))
	return n, err == nil && n > 0
}

// Diff builds both sides of rg and compares them. worktree supplies the
// worktree's graph when rg.To is the worktree.
func (r *Repo) Diff(ctx context.Context, rg Range, worktree func() (*graph.Graph, error)) (*graph.GraphDiff, error) {
	type res struct {
		g   *graph.Graph
		err error
	}
	ach := make(chan res, 1)
	go func() {
		g, _, err := r.Build(ctx, rg.From)
		ach <- res{g, err}
	}()
	var b *graph.Graph
	var err error
	if IsWorktree(rg.To) {
		b, err = worktree()
	} else {
		b, _, err = r.Build(ctx, rg.To)
	}
	a := <-ach
	if err != nil {
		return nil, err
	}
	if a.err != nil {
		return nil, a.err
	}
	files, err := r.Changes(ctx, rg.From, rg.To)
	if err != nil {
		return nil, err
	}
	d := graph.Diff(a.g, b, files)
	d.From, d.To = rg.From, rg.To
	return d, nil
}
