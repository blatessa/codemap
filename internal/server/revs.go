package server

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"github.com/blatessa/codemap/internal/gitrev"
	"github.com/blatessa/codemap/internal/graph"
)

// BuildTimeout is how long a request waits for a revision to build before
// answering 504 {building: true}. The build carries on, and the viewer retries.
var BuildTimeout = 90 * time.Second

func isWorktree(r *http.Request) bool { return gitrev.IsWorktree(r.URL.Query().Get("rev")) }

func (s *Server) needRepo(w http.ResponseWriter) bool {
	if s.repo == nil {
		writeError(w, http.StatusNotImplemented, "not a git repository, so only the worktree is available")
		return false
	}
	return true
}

func (s *Server) buildErr(w http.ResponseWriter, err error) {
	if errors.Is(err, context.DeadlineExceeded) {
		writeJSON(w, http.StatusGatewayTimeout, map[string]any{"error": "still building", "building": true})
		return
	}
	writeError(w, http.StatusUnprocessableEntity, err.Error())
}

// onBuild publishes build progress as `building` events.
func (s *Server) onBuild(sha, phase string) {
	s.events.publish(Event{Name: "building", Data: EventData{Rev: sha, Phase: phase}})
}

func (s *Server) handleRevState(w http.ResponseWriter, r *http.Request) {
	if !s.needRepo(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), BuildTimeout)
	defer cancel()
	g, p, err := s.repo.Build(ctx, r.URL.Query().Get("rev"))
	if err != nil {
		s.buildErr(w, err)
		return
	}
	var buf bytes.Buffer
	if err := g.Encode(&buf); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stateResponse{Graph: buf.Bytes(), Project: projectJSON(p), Versions: map[string]string{}})
}

func (s *Server) handleRevProposals(w http.ResponseWriter, r *http.Request) {
	if !s.needRepo(w) {
		return
	}
	sha, err := s.repo.Resolve(r.Context(), r.URL.Query().Get("rev"))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	p, _, err := s.repo.Project(r.Context(), sha)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, projectJSON(p).Proposals)
}

func (s *Server) handleRevSource(w http.ResponseWriter, r *http.Request, rel string, from, to int) {
	if !s.needRepo(w) {
		return
	}
	sha, err := s.repo.Resolve(r.Context(), r.URL.Query().Get("rev"))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	b, err := s.repo.Show(r.Context(), sha, filepath.ToSlash(rel))
	if err != nil {
		writeError(w, http.StatusNotFound, "no such file at "+sha[:7])
		return
	}
	lines := []string{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for n := 1; sc.Scan(); n++ {
		if to > 0 && n > to {
			break
		}
		if n >= from {
			lines = append(lines, sc.Text())
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"file": filepath.ToSlash(rel), "from": from, "lines": lines})
}

type revsResponse struct {
	Commits  []gitrev.Commit `json:"commits"`
	Branches []string        `json:"branches"`
	Current  string          `json:"current"` // "" when detached
	Default  string          `json:"default"`
	Head     string          `json:"head"`
	Dirty    bool            `json:"dirty"`
	PRs      []gitrev.PR     `json:"prs"`
}

func (s *Server) handleRevs(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusOK, revsResponse{Commits: []gitrev.Commit{}, Branches: []string{}, PRs: []gitrev.PR{}})
		return
	}
	ctx := r.Context()
	n := 100
	if v, err := strconv.Atoi(r.URL.Query().Get("n")); err == nil && v > 0 && v <= 1000 {
		n = v
	}
	var res revsResponse
	prs := make(chan []gitrev.PR, 1)
	go func() { prs <- s.repo.PRs(ctx) }()
	var err error
	if res.Commits, err = s.repo.Log(ctx, n); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if res.Branches, err = s.repo.Branches(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	res.Current = s.repo.CurrentBranch(ctx)
	res.Default = s.repo.DefaultBranch(ctx)
	res.Head = s.gitHead()
	res.Dirty = s.repo.Dirty(ctx)
	res.PRs = <-prs
	if res.PRs == nil {
		res.PRs = []gitrev.PR{}
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) worktreeGraph() (*graph.Graph, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.graph == nil {
		return nil, errors.New("the map is still being built")
	}
	c := *s.graph
	return &c, nil
}

func (s *Server) rangeOf(w http.ResponseWriter, r *http.Request) (gitrev.Range, bool) {
	q := r.URL.Query()
	from, to := q.Get("from"), q.Get("to")
	if from == "" {
		from = "HEAD"
	}
	rg, err := s.repo.ResolveRange(r.Context(), from, to)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return rg, false
	}
	return rg, true
}

func (s *Server) handleDiff(w http.ResponseWriter, r *http.Request) {
	if !s.needRepo(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), BuildTimeout)
	defer cancel()
	rg, ok := s.rangeOf(w, r.WithContext(ctx))
	if !ok {
		return
	}
	d, err := s.repo.Diff(ctx, rg, s.worktreeGraph)
	if err != nil {
		s.buildErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) handleSourceDiff(w http.ResponseWriter, r *http.Request) {
	if !s.needRepo(w) {
		return
	}
	rel, err := s.relPath(r.URL.Query().Get("file"))
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	rg, ok := s.rangeOf(w, r)
	if !ok {
		return
	}
	ctxLines := 3
	if v, err := strconv.Atoi(r.URL.Query().Get("context")); err == nil && v >= 0 && v <= 10000 {
		ctxLines = v
	}
	out, err := s.repo.FileDiff(r.Context(), rg.From, rg.To, filepath.ToSlash(rel), ctxLines)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"file": filepath.ToSlash(rel), "from": rg.From, "to": rg.To, "diff": string(out)})
}
