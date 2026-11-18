package server

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"time"

	"codemap/internal/anchor"
	"codemap/internal/project"
)

// withAnchors returns copies of the proposals whose items carry the computed
// anchor {file, lines, stale} (PLAN.md §6). The cached proposals are untouched.
func (s *Server) withAnchors(r *http.Request, ps []*project.Proposal) []*project.Proposal {
	res := &anchor.Resolver{Root: s.root, Repo: s.repo, Ctx: r.Context()}
	out := make([]*project.Proposal, len(ps))
	for i, p := range ps {
		out[i] = s.anchored(res, p)
	}
	return out
}

func (s *Server) anchored(res *anchor.Resolver, p *project.Proposal) *project.Proposal {
	if len(p.Items) == 0 {
		return p
	}
	c := *p
	c.Items = make([]map[string]any, len(p.Items))
	for i, it := range p.Items {
		m := make(map[string]any, len(it)+1)
		for k, v := range it {
			m[k] = v
		}
		if a := res.Resolve(it); a != nil {
			m["anchor"] = a
		}
		c.Items[i] = m
	}
	return &c
}

func shortSHA(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

// readProposal reads proposals/<slug>.md with its version.
func (s *Server) readProposal(w http.ResponseWriter, slug string) (*project.Proposal, []byte, string, bool) {
	file := "proposals/" + slug + ".md"
	cur, b, err := s.fileVersion(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return nil, nil, "", false
	}
	if cur == Missing {
		writeError(w, http.StatusNotFound, "no proposal "+strconv.Quote(slug))
		return nil, nil, "", false
	}
	p, err := project.ParseProposal(b)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, file+": "+err.Error())
		return nil, nil, "", false
	}
	p.Slug = slug
	return p, b, cur, true
}

// writeItemEdit writes the proposal after an item edit: the in-place edit when
// it worked, else the whole file re-marshalled. updated is set to today.
func (s *Server) writeItemEdit(w http.ResponseWriter, r *http.Request, p *project.Proposal, inPlace []byte, inPlaceErr error, id string) {
	day := time.Now().Format(time.DateOnly)
	var data []byte
	if inPlaceErr == nil {
		data, inPlaceErr = project.SetFrontmatter(inPlace, [][2]string{{"updated", day}})
	}
	if inPlaceErr != nil {
		p.Updated = day
		var err error
		if data, err = p.Marshal(); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if err := project.WriteFile(s.root, "proposals/"+p.Slug+".md", data); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.afterWrite(false)
	np, err := project.ParseProposal(data)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	np.Slug = p.Slug
	np = s.anchored(&anchor.Resolver{Root: s.root, Repo: s.repo, Ctx: r.Context()}, np)
	var item map[string]any
	if i := np.FindItem(id); i >= 0 {
		item = np.Items[i]
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": version(data), "item": item})
}

func validItem(w http.ResponseWriter, it map[string]any) bool {
	if k, ok := it["kind"]; ok {
		if ks, _ := k.(string); !slices.Contains(project.ItemKinds, ks) {
			writeError(w, http.StatusBadRequest, "kind must be one of change, add, remove, move, rename, test, question")
			return false
		}
	}
	if st, ok := it["status"]; ok {
		if ss, _ := st.(string); !slices.Contains(project.ItemStatuses, ss) {
			writeError(w, http.StatusBadRequest, "status must be open, done or wontfix")
			return false
		}
	}
	return true
}

func decodeItem(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	var it map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&it); err != nil || it == nil {
		msg := "invalid item"
		if err != nil {
			msg += ": " + err.Error()
		}
		writeError(w, http.StatusBadRequest, msg)
		return nil, false
	}
	return it, true
}

// POST /api/proposals/{slug}/items appends an item. The server assigns id,
// rev (HEAD) and status (open).
func (s *Server) handlePostItem(w http.ResponseWriter, r *http.Request) {
	slug, ok := proposalSlug(w, r)
	if !ok || !writeRev(w, r) {
		return
	}
	raw, ok := decodeItem(w, r)
	if !ok {
		return
	}
	it := project.CleanItem(raw)
	delete(it, "id")
	if _, ok := it["kind"]; !ok {
		it["kind"] = "change"
	}
	it["status"] = "open"
	if !validItem(w, it) {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	p, b, cur, ok := s.readProposal(w, slug)
	if !ok {
		return
	}
	if m := ifMatch(r); m != "" && m != cur {
		writeJSON(w, http.StatusConflict, conflict{Version: cur, Value: parseProposalFile(slug, b)})
		return
	}
	it["id"] = p.NextItemID()
	if _, ok := it["rev"]; !ok {
		if h := shortSHA(s.gitHead()); h != "" {
			it["rev"] = h
		}
	}
	data, err := project.AppendItem(b, it)
	p.Items = append(p.Items, it)
	s.writeItemEdit(w, r, p, data, err, project.ItemStr(it, "id"))
}

// PATCH /api/proposals/{slug}/items/{id} sets the given keys; null removes one.
func (s *Server) handlePatchItem(w http.ResponseWriter, r *http.Request) {
	slug, ok := proposalSlug(w, r)
	if !ok || !writeRev(w, r) {
		return
	}
	id := r.PathValue("id")
	patch, ok := decodeItem(w, r)
	if !ok {
		return
	}
	delete(patch, "anchor")
	delete(patch, "id")
	for k, v := range patch {
		if v != nil {
			continue
		}
		if k == "kind" || k == "status" {
			writeError(w, http.StatusBadRequest, k+" can't be removed")
			return
		}
	}
	check := map[string]any{}
	for k, v := range patch {
		if v != nil {
			check[k] = v
		}
	}
	if !validItem(w, check) {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	p, b, cur, ok := s.readProposal(w, slug)
	if !ok {
		return
	}
	if m := ifMatch(r); m != "" && m != cur {
		writeJSON(w, http.StatusConflict, conflict{Version: cur, Value: parseProposalFile(slug, b)})
		return
	}
	i := p.FindItem(id)
	if i < 0 {
		writeError(w, http.StatusNotFound, "no item "+strconv.Quote(id))
		return
	}
	for k, v := range patch {
		if v == nil {
			delete(p.Items[i], k)
		} else {
			p.Items[i][k] = v
		}
	}
	data, err := project.PatchItem(b, id, patch)
	s.writeItemEdit(w, r, p, data, err, id)
}

// cleanItems drops computed keys before a whole proposal is written.
func cleanItems(p *project.Proposal) {
	for i, it := range p.Items {
		p.Items[i] = project.CleanItem(it)
	}
}
