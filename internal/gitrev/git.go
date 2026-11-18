// Package gitrev is codemap's git layer (PLAN.md §7): it builds the graph at any
// revision in a pooled temporary worktree, caches the result by commit, reads
// .codemap/ and source files from git, and works out what changed between two
// revisions.
package gitrev

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing/fstest"
	"time"

	"codemap/internal/graph"
	"codemap/internal/project"
)

// Worktree is the rev name for the working directory, uncommitted changes included.
const Worktree = "worktree"

// IsWorktree reports whether rev means the working directory.
func IsWorktree(rev string) bool { return rev == "" || rev == Worktree }

// ErrNotGit is returned by Open outside a git repository.
var ErrNotGit = errors.New("not a git repository")

func git(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return out, fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return out, nil
}

func gitLine(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := git(ctx, dir, args...)
	return strings.TrimSpace(string(out)), err
}

// Resolve turns a rev into a full commit sha. It understands everything git
// does, plus "base:<rev>" for the merge-base of <rev> and HEAD.
func (r *Repo) Resolve(ctx context.Context, rev string) (string, error) {
	if IsWorktree(rev) {
		return "", errors.New("the worktree has no sha")
	}
	if b, ok := strings.CutPrefix(rev, "base:"); ok {
		return r.MergeBase(ctx, b, "HEAD")
	}
	if strings.HasPrefix(rev, "-") {
		return "", fmt.Errorf("bad rev %q", rev)
	}
	sha, err := gitLine(ctx, r.Root, "rev-parse", "--verify", "--quiet", "--end-of-options", rev+"^{commit}")
	if err != nil || sha == "" {
		return "", fmt.Errorf("unknown revision %q", rev)
	}
	return sha, nil
}

// MergeBase returns the best common ancestor of a and b ("worktree" means HEAD).
func (r *Repo) MergeBase(ctx context.Context, a, b string) (string, error) {
	if IsWorktree(b) {
		b = "HEAD"
	}
	for _, x := range []string{a, b} {
		if strings.HasPrefix(x, "-") {
			return "", fmt.Errorf("bad rev %q", x)
		}
	}
	sha, err := gitLine(ctx, r.Root, "merge-base", a, b)
	if err != nil {
		return "", fmt.Errorf("no merge base for %s and %s", a, b)
	}
	return sha, nil
}

// Show returns a file's contents at a commit.
func (r *Repo) Show(ctx context.Context, sha, file string) ([]byte, error) {
	return git(ctx, r.Root, "show", sha+":"+filepath.ToSlash(file))
}

// Project loads .codemap/ as it is at a commit, and returns a hash of the files
// that affect the graph (config.toml and external.toml).
func (r *Repo) Project(ctx context.Context, sha string) (*project.Project, string, error) {
	out, err := git(ctx, r.Root, "ls-tree", "-r", "-z", "--name-only", sha, "--", project.Dir+"/")
	if err != nil {
		return nil, "", err
	}
	mfs := fstest.MapFS{}
	h := newHash()
	for _, name := range strings.Split(string(out), "\x00") {
		if name == "" {
			continue
		}
		b, err := r.Show(ctx, sha, name)
		if err != nil {
			return nil, "", err
		}
		rel := strings.TrimPrefix(name, project.Dir+"/")
		mfs[rel] = &fstest.MapFile{Data: b}
		if rel == "config.toml" || rel == "external.toml" {
			fmt.Fprintf(h, "%s\x00%d\x00", rel, len(b))
			h.Write(b)
		}
	}
	p, err := project.LoadFS(mfs)
	if err != nil {
		return nil, "", fmt.Errorf("%s at %s: %w", project.Dir, short(sha), err)
	}
	return p, hexSum(h, 6), nil
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// Commit is one entry of the log.
type Commit struct {
	SHA     string   `json:"sha"`
	Short   string   `json:"short"`
	Subject string   `json:"subject"`
	Author  string   `json:"author"`
	Date    string   `json:"date"` // RFC 3339
	Parents []string `json:"parents"`
	Refs    []string `json:"refs"`
}

// Log returns the most recent n commits reachable from HEAD and local branches.
func (r *Repo) Log(ctx context.Context, n int) ([]Commit, error) {
	out, err := git(ctx, r.Root, "log", "--branches", "HEAD", "--topo-order", "-n", strconv.Itoa(n),
		"--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P%x1f%D%x1e")
	if err != nil {
		if strings.Contains(err.Error(), "does not have any commits") || strings.Contains(err.Error(), "unknown revision") {
			return []Commit{}, nil
		}
		return nil, err
	}
	cs := []Commit{}
	for _, rec := range strings.Split(string(out), "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		f := strings.Split(rec, "\x1f")
		if len(f) < 7 {
			continue
		}
		c := Commit{SHA: f[0], Short: f[1], Subject: f[2], Author: f[3], Date: f[4], Parents: strings.Fields(f[5]), Refs: []string{}}
		for _, ref := range strings.Split(strings.TrimSpace(f[6]), ", ") {
			ref = strings.TrimPrefix(ref, "HEAD -> ")
			ref = strings.TrimPrefix(ref, "tag: ")
			if ref != "" && ref != "HEAD" {
				c.Refs = append(c.Refs, ref)
			}
		}
		cs = append(cs, c)
	}
	return cs, nil
}

// Branches lists local branches, most recently committed first.
func (r *Repo) Branches(ctx context.Context) ([]string, error) {
	out, err := git(ctx, r.Root, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/")
	if err != nil {
		return nil, err
	}
	bs := []string{}
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" {
			bs = append(bs, l)
		}
	}
	return bs, nil
}

// CurrentBranch returns HEAD's branch, or "" when detached.
func (r *Repo) CurrentBranch(ctx context.Context) string {
	b, err := gitLine(ctx, r.Root, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return ""
	}
	return b
}

// DefaultBranch returns main or master if either exists locally, else origin/HEAD's target.
func (r *Repo) DefaultBranch(ctx context.Context) string {
	for _, b := range []string{"main", "master"} {
		if _, err := git(ctx, r.Root, "rev-parse", "--verify", "--quiet", "refs/heads/"+b); err == nil {
			return b
		}
	}
	if b, err := gitLine(ctx, r.Root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
		return b
	}
	return ""
}

// Dirty reports whether the worktree has uncommitted changes (untracked files included).
func (r *Repo) Dirty(ctx context.Context) bool {
	out, err := git(ctx, r.Root, "status", "--porcelain", "--untracked-files=normal")
	return err == nil && len(bytes.TrimSpace(out)) > 0
}

// PR is an open GitHub pull request.
type PR struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	HeadRefName string `json:"headRefName"`
	BaseRefName string `json:"baseRefName"`
	Author      struct {
		Login string `json:"login"`
	} `json:"author"`
	UpdatedAt string `json:"updatedAt"`
}

// hasGitHubRemote reports whether any remote points at github.com.
func (r *Repo) hasGitHubRemote(ctx context.Context) bool {
	out, err := git(ctx, r.Root, "remote", "-v")
	return err == nil && bytes.Contains(out, []byte("github.com"))
}

// ghAvailable reports whether gh can be asked about PRs.
func (r *Repo) ghAvailable(ctx context.Context) bool {
	if _, err := exec.LookPath("gh"); err != nil {
		return false
	}
	return r.hasGitHubRemote(ctx)
}

func (r *Repo) gh(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = r.Root
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "NO_COLOR=1")
	return cmd.Output()
}

// PRs lists open pull requests, or nil when gh or a GitHub remote is missing
// or gh fails (not logged in, offline).
func (r *Repo) PRs(ctx context.Context) []PR {
	if !r.ghAvailable(ctx) {
		return nil
	}
	out, err := r.gh(ctx, "pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,headRefName,baseRefName,author,updatedAt")
	if err != nil {
		return nil
	}
	var prs []PR
	if err := jsonUnmarshal(out, &prs); err != nil {
		return nil
	}
	return prs
}

// ResolvePR returns the base (merge-base with the base branch) and head shas of
// PR n, fetching the head with `git fetch origin pull/N/head` when it isn't here.
func (r *Repo) ResolvePR(ctx context.Context, n int) (base, head string, err error) {
	baseRef, headSHA := "", ""
	if r.ghAvailable(ctx) {
		if out, err := r.gh(ctx, "pr", "view", strconv.Itoa(n), "--json", "baseRefName,headRefOid"); err == nil {
			var v struct{ BaseRefName, HeadRefOid string }
			if jsonUnmarshal(out, &v) == nil {
				baseRef, headSHA = v.BaseRefName, v.HeadRefOid
			}
		}
	}
	if headSHA == "" || !r.hasCommit(ctx, headSHA) {
		if _, err := git(ctx, r.Root, "fetch", "--quiet", "origin", fmt.Sprintf("pull/%d/head", n)); err != nil {
			return "", "", fmt.Errorf("pr %d: %w", n, err)
		}
		if headSHA == "" {
			if headSHA, err = gitLine(ctx, r.Root, "rev-parse", "FETCH_HEAD"); err != nil {
				return "", "", err
			}
		}
	}
	if baseRef == "" {
		baseRef = r.DefaultBranch(ctx)
	}
	for _, cand := range []string{"origin/" + baseRef, baseRef} {
		if base, err = r.MergeBase(ctx, cand, headSHA); err == nil {
			return base, headSHA, nil
		}
	}
	return "", "", fmt.Errorf("pr %d: no merge base with %s", n, baseRef)
}

func (r *Repo) hasCommit(ctx context.Context, sha string) bool {
	_, err := git(ctx, r.Root, "cat-file", "-e", sha+"^{commit}")
	return err == nil
}

// Changes returns the files that differ between commit a and b (b may be the
// worktree), with -U0 hunk ranges and git's rename detection.
func (r *Repo) Changes(ctx context.Context, a, b string) ([]graph.FileChange, error) {
	args := []string{"diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", a}
	if !IsWorktree(b) {
		args = append(args, b)
	}
	out, err := git(ctx, r.Root, args...)
	if err != nil {
		return nil, err
	}
	return ParseUnified(out), nil
}

// FileDiff returns the unified diff of one file between a and b (b may be the
// worktree). Renames are followed when the file was renamed.
func (r *Repo) FileDiff(ctx context.Context, a, b, file string, context int) ([]byte, error) {
	args := []string{"diff", "-M", "--no-color", "--no-ext-diff", fmt.Sprintf("-U%d", context), a}
	if !IsWorktree(b) {
		args = append(args, b)
	}
	args = append(args, "--", file)
	if old := r.renamedFrom(ctx, a, b, file); old != "" {
		args = append(args, old)
	}
	return git(ctx, r.Root, args...)
}

func (r *Repo) renamedFrom(ctx context.Context, a, b, file string) string {
	fc, err := r.Changes(ctx, a, b)
	if err != nil {
		return ""
	}
	for _, f := range fc {
		if f.New == file && f.Old != "" && f.Old != file {
			return f.Old
		}
	}
	return ""
}

// ParseUnified reads `git diff -U0` output into file changes.
func ParseUnified(out []byte) []graph.FileChange {
	var fcs []graph.FileChange
	var cur *graph.FileChange
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64<<10), 16<<20)
	for sc.Scan() {
		l := sc.Text()
		switch {
		case strings.HasPrefix(l, "diff --git "):
			fcs = append(fcs, graph.FileChange{})
			cur = &fcs[len(fcs)-1]
			// fallback paths for pure renames and binary files: "diff --git a/x b/y"
			if i := strings.Index(l, " b/"); i > 0 {
				cur.Old = unquote(strings.TrimPrefix(l[len("diff --git "):i], "a/"))
				cur.New = unquote(l[i+3:])
			}
		case cur == nil:
		case strings.HasPrefix(l, "--- "):
			cur.Old = diffPath(l[4:], "a/")
		case strings.HasPrefix(l, "+++ "):
			cur.New = diffPath(l[4:], "b/")
		case strings.HasPrefix(l, "rename from "):
			cur.Old = unquote(l[len("rename from "):])
		case strings.HasPrefix(l, "rename to "):
			cur.New = unquote(l[len("rename to "):])
		case strings.HasPrefix(l, "new file mode"):
			cur.Old = ""
		case strings.HasPrefix(l, "deleted file mode"):
			cur.New = ""
		case strings.HasPrefix(l, "@@ "):
			o, n, ok := parseHunk(l)
			if !ok {
				continue
			}
			if o[1] > 0 {
				cur.OldHunks = append(cur.OldHunks, [2]int{o[0], o[0] + o[1] - 1})
			}
			if n[1] > 0 {
				cur.NewHunks = append(cur.NewHunks, [2]int{n[0], n[0] + n[1] - 1})
			}
		}
	}
	return fcs
}

func diffPath(s, prefix string) string {
	s = unquote(strings.TrimSuffix(s, "\t"))
	if s == "/dev/null" {
		return ""
	}
	return strings.TrimPrefix(s, prefix)
}

func unquote(s string) string {
	if strings.HasPrefix(s, `"`) {
		if u, err := strconv.Unquote(s); err == nil {
			return u
		}
	}
	return s
}

// parseHunk reads "@@ -a,b +c,d @@" into [start, count] pairs.
func parseHunk(l string) (o, n [2]int, ok bool) {
	f := strings.Fields(l)
	if len(f) < 3 {
		return o, n, false
	}
	pr := func(s string) ([2]int, bool) {
		s = s[1:]
		start, count := s, "1"
		if i := strings.IndexByte(s, ','); i >= 0 {
			start, count = s[:i], s[i+1:]
		}
		a, err1 := strconv.Atoi(start)
		b, err2 := strconv.Atoi(count)
		return [2]int{a, b}, err1 == nil && err2 == nil
	}
	o, ok1 := pr(f[1])
	n, ok2 := pr(f[2])
	return o, n, ok1 && ok2
}
