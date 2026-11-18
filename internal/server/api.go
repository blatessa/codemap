package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"codemap/internal/project"
)

const maxBody = 10 << 20

func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeRev rejects writes for any rev other than the worktree.
func writeRev(w http.ResponseWriter, r *http.Request) bool {
	rev := r.URL.Query().Get("rev")
	if rev == "" || rev == "worktree" {
		return true
	}
	writeError(w, http.StatusMethodNotAllowed, fmt.Sprintf("rev %q is read-only; writes only happen in the worktree", rev))
	return false
}

func ifMatch(r *http.Request) string {
	v := strings.TrimSpace(r.Header.Get("If-Match"))
	v = strings.TrimPrefix(v, "W/")
	return strings.Trim(v, `"`)
}

// projectJSON is the project as sent to the viewer, with empty lists instead of null.
func projectJSON(p *project.Project) project.Project {
	c := *p
	if c.Areas == nil {
		c.Areas = []project.Area{}
	}
	if c.Blocks == nil {
		c.Blocks = []project.Block{}
	}
	if c.Layout == nil {
		c.Layout = project.Layout{}
	}
	if c.Proposals == nil {
		c.Proposals = []*project.Proposal{}
	}
	return c
}

type stateResponse struct {
	Graph    json.RawMessage   `json:"graph"`
	Project  project.Project   `json:"project"`
	Versions map[string]string `json:"versions"`
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	if !isWorktree(r) {
		s.handleRevState(w, r)
		return
	}
	s.mu.RLock()
	g, p, v := s.graphRaw, s.proj, s.versions
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, stateResponse{Graph: g, Project: projectJSON(p), Versions: v})
}

// kinds describes how each writable project file is decoded and encoded.
type fileKind struct {
	zero    func() any // pointer to an empty value
	marshal func(v any) ([]byte, error)
	parse   func(b []byte, v any) error
	fix     func(v any) // normalise nil slices and fill defaults
}

// listKind is a TOML file holding a list as [[key]] tables.
func listKind[T any](key string, fix func(*[]T)) fileKind {
	return fileKind{
		zero:    func() any { v := []T{}; return &v },
		marshal: func(v any) ([]byte, error) { return project.MarshalList(key, *v.(*[]T)) },
		parse:   func(b []byte, v any) error { return project.UnmarshalList(key, b, v.(*[]T)) },
		fix: func(v any) {
			if fix != nil {
				fix(v.(*[]T))
			}
		},
	}
}

func tomlKind[T any](empty T, fix func(*T)) fileKind {
	return fileKind{
		zero:    func() any { v := empty; return &v },
		marshal: func(v any) ([]byte, error) { return project.MarshalTOML(*v.(*T)) },
		parse:   func(b []byte, v any) error { return project.UnmarshalTOML(b, v) },
		fix: func(v any) {
			if fix != nil {
				fix(v.(*T))
			}
		},
	}
}

var kinds = map[string]fileKind{
	"areas": listKind(project.AreaKey, func(v *[]project.Area) {
		if *v == nil {
			*v = []project.Area{}
		}
	}),
	"blocks": listKind(project.BlockKey, func(v *[]project.Block) {
		if *v == nil {
			*v = []project.Block{}
		}
		for i := range *v {
			if b := &(*v)[i]; b.ID == "" && b.Name != "" {
				b.ID = "block:" + project.Slugify(b.Name)
			}
		}
	}),
	"external": tomlKind(project.External{}, nil),
	"layout": {
		zero:    func() any { return &project.Layout{} },
		marshal: func(v any) ([]byte, error) { return project.MarshalLayout(*v.(*project.Layout)) },
		parse:   func(b []byte, v any) error { return json.Unmarshal(b, v) },
		fix: func(v any) {
			if l := v.(*project.Layout); *l == nil {
				*l = project.Layout{}
			}
		},
	},
}

// currentValue parses the bytes of a project file for a 409 body. A missing
// file is the empty value; an unparseable one is null.
func currentValue(k fileKind, b []byte) any {
	v := k.zero()
	if b != nil {
		if err := k.parse(b, v); err != nil {
			return nil
		}
	}
	k.fix(v)
	return v
}

type conflict struct {
	Version string `json:"version"`
	Value   any    `json:"value"`
	Error   string `json:"error,omitempty"`
}

func (s *Server) handlePutProject(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	file, ok := projectFiles[name]
	if !ok {
		writeError(w, http.StatusNotFound, "unknown project file "+strconv.Quote(name))
		return
	}
	if !writeRev(w, r) {
		return
	}
	k := kinds[name]
	val := k.zero()
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(val); err != nil {
		writeError(w, http.StatusBadRequest, "invalid "+name+": "+err.Error())
		return
	}
	k.fix(val)
	data, err := k.marshal(val)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.writeMu.Lock()
	cur, curBytes, err := s.fileVersion(file)
	if err != nil {
		s.writeMu.Unlock()
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	switch m := ifMatch(r); {
	case m == "":
		s.writeMu.Unlock()
		writeJSON(w, http.StatusPreconditionRequired, conflict{cur, currentValue(k, curBytes), "If-Match is required"})
		return
	case m != cur:
		s.writeMu.Unlock()
		writeJSON(w, http.StatusConflict, conflict{Version: cur, Value: currentValue(k, curBytes)})
		return
	}
	err = project.WriteFile(s.root, file, data)
	s.writeMu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.afterWrite(name == "external")
	writeJSON(w, http.StatusOK, map[string]string{"version": version(data)})
}

// afterWrite refreshes the cache right away so a following GET sees the write.
// The watcher will also notice the change and send project-changed.
func (s *Server) afterWrite(graphToo bool) {
	if err := s.reloadProject(); err != nil {
		s.log.Printf("reload .codemap: %v", err)
	}
	if graphToo {
		if err := s.rebuildGraph(); err != nil {
			s.log.Printf("rebuild: %v", err)
		}
	}
}

func (s *Server) handleListProposals(w http.ResponseWriter, r *http.Request) {
	if !isWorktree(r) {
		s.handleRevProposals(w, r)
		return
	}
	s.mu.RLock()
	p := s.proj
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, projectJSON(p).Proposals)
}

var slugRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func proposalSlug(w http.ResponseWriter, r *http.Request) (string, bool) {
	slug := r.PathValue("slug")
	if !slugRE.MatchString(slug) || strings.Contains(slug, "..") {
		writeError(w, http.StatusBadRequest, "invalid proposal slug "+strconv.Quote(slug))
		return "", false
	}
	return slug, true
}

func parseProposalFile(slug string, b []byte) any {
	if b == nil {
		return nil
	}
	p, err := project.ParseProposal(b)
	if err != nil {
		return nil
	}
	p.Slug = slug
	return p
}

func (s *Server) handlePutProposal(w http.ResponseWriter, r *http.Request) {
	slug, ok := proposalSlug(w, r)
	if !ok || !writeRev(w, r) {
		return
	}
	var p project.Proposal
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&p); err != nil {
		writeError(w, http.StatusBadRequest, "invalid proposal: "+err.Error())
		return
	}
	file := "proposals/" + slug + ".md"

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cur, curBytes, err := s.fileVersion(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	m := ifMatch(r)
	switch {
	case cur == Missing && m != "" && m != Missing:
		writeJSON(w, http.StatusConflict, conflict{Version: Missing, Value: nil})
		return
	case cur != Missing && m == "":
		writeJSON(w, http.StatusPreconditionRequired, conflict{cur, parseProposalFile(slug, curBytes), "If-Match is required to overwrite an existing proposal"})
		return
	case cur != Missing && m != cur:
		writeJSON(w, http.StatusConflict, conflict{Version: cur, Value: parseProposalFile(slug, curBytes)})
		return
	}
	p.Slug = slug
	if cur == Missing && p.Base == "" {
		p.Base = s.gitHead()
	}
	if p.Status == "" {
		p.Status = "open"
	}
	p.Updated = time.Now().Format(time.DateOnly)
	data, err := p.Marshal()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := project.WriteFile(s.root, file, data); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.afterWrite(false)
	writeJSON(w, http.StatusOK, map[string]string{"version": version(data)})
}

func (s *Server) handleDeleteProposal(w http.ResponseWriter, r *http.Request) {
	slug, ok := proposalSlug(w, r)
	if !ok || !writeRev(w, r) {
		return
	}
	file := "proposals/" + slug + ".md"
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cur, curBytes, err := s.fileVersion(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if cur == Missing {
		writeError(w, http.StatusNotFound, "no proposal "+strconv.Quote(slug))
		return
	}
	if m := ifMatch(r); m != "" && m != cur {
		writeJSON(w, http.StatusConflict, conflict{Version: cur, Value: parseProposalFile(slug, curBytes)})
		return
	}
	if err := os.Remove(filepath.Join(s.root, project.Dir, "proposals", slug+".md")); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.afterWrite(false)
	w.WriteHeader(http.StatusNoContent)
}

// relPath turns a request's file (repo-relative or absolute) into a clean,
// slash-free-of-escapes relative path, or an error if it leaves the root.
func (s *Server) relPath(file string) (string, error) {
	if file == "" {
		return "", errors.New("file is required")
	}
	rel := filepath.FromSlash(file)
	if filepath.IsAbs(rel) {
		var err error
		if rel, err = filepath.Rel(s.root, rel); err != nil {
			return "", errors.New("file is outside the repo")
		}
	}
	rel = filepath.Clean(rel)
	if !filepath.IsLocal(rel) {
		return "", errors.New("file is outside the repo")
	}
	return rel, nil
}

// openInRoot opens a file confined to the root, symlinks included.
func (s *Server) openInRoot(rel string) (*os.File, int, error) {
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	defer root.Close()
	f, err := root.Open(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, http.StatusNotFound, errors.New("no such file")
	}
	if err != nil {
		return nil, http.StatusForbidden, errors.New("file is outside the repo")
	}
	if fi, err := f.Stat(); err != nil || fi.IsDir() {
		f.Close()
		return nil, http.StatusBadRequest, errors.New("not a regular file")
	}
	return f, 0, nil
}

func (s *Server) handleSource(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rel, err := s.relPath(q.Get("file"))
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	from, to := 1, 0
	if v := q.Get("from"); v != "" {
		if from, err = strconv.Atoi(v); err != nil || from < 1 {
			writeError(w, http.StatusBadRequest, "from must be a line number ≥ 1")
			return
		}
	}
	if v := q.Get("to"); v != "" {
		if to, err = strconv.Atoi(v); err != nil || to < from {
			writeError(w, http.StatusBadRequest, "to must be a line number ≥ from")
			return
		}
	}
	if !isWorktree(r) {
		s.handleRevSource(w, r, rel, from, to)
		return
	}
	f, status, err := s.openInRoot(rel)
	if err != nil {
		writeError(w, status, err.Error())
		return
	}
	defer f.Close()
	lines := []string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for n := 1; sc.Scan(); n++ {
		if to > 0 && n > to {
			break
		}
		if n >= from {
			lines = append(lines, sc.Text())
		}
	}
	if err := sc.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"file": filepath.ToSlash(rel), "from": from, "lines": lines})
}

// editorArgs builds the editor command line without a shell. A configured
// template has {file} and {line} replaced in each word (the file is appended if
// the template has no {file}); otherwise $VISUAL or $EDITOR gets "+line file".
func editorArgs(tmpl, file string, line int) ([]string, error) {
	ln := strconv.Itoa(line)
	if tmpl == "" {
		ed := os.Getenv("VISUAL")
		if ed == "" {
			ed = os.Getenv("EDITOR")
		}
		args := strings.Fields(ed)
		if len(args) == 0 {
			return nil, errors.New("no editor: set editor in .codemap/config.toml, or $VISUAL or $EDITOR")
		}
		return defaultEditorArgs(args, file, line, lookTerminal)
	}
	args := strings.Fields(tmpl)
	if len(args) == 0 {
		return nil, errors.New("editor in .codemap/config.toml is empty")
	}
	hasFile := false
	for i, a := range args {
		if strings.Contains(a, "{file}") {
			hasFile = true
		}
		args[i] = strings.NewReplacer("{file}", file, "{line}", ln).Replace(a)
	}
	if !hasFile {
		args = append(args, file)
	}
	return args, nil
}

// Editors whose line syntax we know. The server has no terminal of its own, so
// terminal editors are started inside a terminal emulator.
var (
	guiEditors = map[string]string{ // name -> line syntax
		"code": "-g file:line", "code-insiders": "-g file:line", "codium": "-g file:line", "cursor": "-g file:line",
		"subl": "file:line", "zed": "file:line", "gedit": "+line file", "kate": "-l line file",
		"idea": "--line line file", "goland": "--line line file", "webstorm": "--line line file",
	}
	termEditors = map[string]string{
		"vi": "+line file", "vim": "+line file", "nvim": "+line file", "nano": "+line file",
		"emacs": "-nw +line file", "kak": "+line file", "micro": "file:line", "hx": "file:line", "helix": "file:line",
	}
)

// defaultEditorArgs turns $VISUAL/$EDITOR into a command. Known GUI editors run
// directly; known terminal editors run in a terminal. Anything else (a wrapper
// script, say) runs in a terminal with just the file, since its line syntax is
// unknown; set editor in .codemap/config.toml for full control.
func defaultEditorArgs(ed []string, file string, line int, term func() []string) ([]string, error) {
	name := filepath.Base(ed[0])
	expand := func(syntax string) []string {
		var out []string
		for _, w := range strings.Fields(syntax) {
			out = append(out, strings.NewReplacer("file", file, "line", strconv.Itoa(line)).Replace(w))
		}
		return out
	}
	if syn, ok := guiEditors[name]; ok {
		return append(append([]string{}, ed...), expand(syn)...), nil
	}
	cmd := append(append([]string{}, ed...), file)
	if syn, ok := termEditors[name]; ok {
		cmd = append(append([]string{}, ed...), expand(syn)...)
	}
	t := term()
	if t == nil {
		return nil, errors.New("no terminal found to run " + name + " in: set $TERMINAL, or editor in .codemap/config.toml")
	}
	return append(t, cmd...), nil
}

// lookTerminal finds a terminal emulator and the arguments that precede the
// command to run in it.
func lookTerminal() []string {
	cands := []string{os.Getenv("TERMINAL"), "xdg-terminal-exec", "x-terminal-emulator", "ghostty", "kitty", "alacritty", "foot", "wezterm", "gnome-terminal", "konsole", "xterm"}
	for _, c := range cands {
		f := strings.Fields(c)
		if len(f) == 0 {
			continue
		}
		if _, err := exec.LookPath(f[0]); err != nil {
			continue
		}
		switch filepath.Base(f[0]) {
		case "xdg-terminal-exec":
			return f
		case "gnome-terminal", "kgx":
			return append(f, "--")
		case "wezterm":
			return append(f, "start", "--")
		default:
			return append(f, "-e")
		}
	}
	return nil
}

func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	if !writeRev(w, r) {
		return
	}
	var req struct {
		File string `json:"file"`
		Line int    `json:"line"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	rel, err := s.relPath(req.File)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	f, status, err := s.openInRoot(rel)
	if err != nil {
		writeError(w, status, err.Error())
		return
	}
	f.Close()
	if req.Line < 1 {
		req.Line = 1
	}
	s.mu.RLock()
	tmpl := s.proj.Config.Editor
	s.mu.RUnlock()
	args, err := editorArgs(tmpl, filepath.Join(s.root, rel), req.Line)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = s.root
	if err := s.startCmd(cmd); err != nil {
		writeError(w, http.StatusInternalServerError, "run editor: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	ch := s.events.subscribe()
	defer s.events.unsubscribe(ch)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	fl.Flush()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			b, _ := json.Marshal(ev.Data)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Name, b)
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

const placeholder = `<!doctype html>
<html><head><meta charset="utf-8"><title>codemap</title></head>
<body style="font:14px system-ui;margin:2rem">
<p>codemap is running. The viewer is not bundled in this build.</p>
<p>API: <a href="/api/state">/api/state</a></p>
</body></html>
`

func (s *Server) handleAssets(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "no such endpoint")
		return
	}
	if s.assets == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(placeholder))
		return
	}
	p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if p != "" && p != "index.html" {
		if fi, err := fs.Stat(s.assets, p); err == nil && !fi.IsDir() {
			http.ServeFileFS(w, r, s.assets, p)
			return
		}
	}
	b, err := fs.ReadFile(s.assets, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(b)
}
