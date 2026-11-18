package server

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"codemap/internal/project"
)

// Event is one server-sent event.
type Event struct {
	Name string    // graph-changed | project-changed | building
	Data EventData // sent as JSON
}

// EventData is the payload of every event.
type EventData struct {
	// Files are .codemap-relative for project-changed (matching the keys of
	// versions, with extensions) and repo-relative for graph-changed.
	Files []string `json:"files"`
	// Error is set when the reload or rebuild failed; the last good state is
	// still being served.
	Error string `json:"error,omitempty"`
	// Rev and Phase are set on `building` events: the commit being built and
	// checkout | extract | done.
	Rev   string `json:"rev,omitempty"`
	Phase string `json:"phase,omitempty"`
}

type broker struct {
	mu   sync.Mutex
	subs map[chan Event]bool
}

func (b *broker) subscribe() chan Event {
	ch := make(chan Event, 16)
	b.mu.Lock()
	if b.subs == nil {
		b.subs = map[chan Event]bool{}
	}
	b.subs[ch] = true
	b.mu.Unlock()
	return ch
}

func (b *broker) unsubscribe(ch chan Event) {
	b.mu.Lock()
	delete(b.subs, ch)
	b.mu.Unlock()
}

func (b *broker) publish(ev Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- ev:
		default: // slow client; it will catch up on the next event
		}
	}
}

// Watch watches the repo until ctx is done, rebuilding and sending events on
// changes. It returns once the watcher is set up.
func (s *Server) Watch(ctx context.Context) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.mu.RLock()
	exclude := s.proj.Config.Exclude
	s.mu.RUnlock()
	sk := &skipper{root: s.root, exclude: exclude, ignored: gitIgnoredDirs(s.root)}
	s.addTree(w, s.root, sk)

	// A graph file outside the repo is watched too.
	var graphDir string
	if s.graphFile != "" {
		if rel, err := filepath.Rel(s.root, s.graphFile); err != nil || !filepath.IsLocal(rel) {
			graphDir = filepath.Dir(s.graphFile)
			if err := w.Add(graphDir); err != nil {
				s.log.Printf("watch %s: %v", graphDir, err)
			}
		}
	}

	go func() {
		defer w.Close()
		pending := map[string]bool{}
		timer := time.NewTimer(time.Hour)
		timer.Stop()
		for {
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				s.log.Printf("watch: %v", err)
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if ev.Op == fsnotify.Chmod {
					continue
				}
				if graphDir != "" && filepath.Dir(ev.Name) == graphDir {
					if ev.Name == s.graphFile {
						pending[ev.Name] = true
						timer.Reset(s.debounce)
					}
					continue
				}
				rel, err := filepath.Rel(s.root, ev.Name)
				if err != nil || !filepath.IsLocal(rel) {
					continue
				}
				rel = filepath.ToSlash(rel)
				if sk.skip(rel) || strings.HasPrefix(path.Base(rel), ".tmp-") {
					continue
				}
				if ev.Op&fsnotify.Create != 0 {
					if fi, err := os.Stat(ev.Name); err == nil && fi.IsDir() {
						s.addTree(w, ev.Name, sk)
					}
				}
				pending[rel] = true
				timer.Reset(s.debounce)
			case <-timer.C:
				s.apply(sortedKeys(pending))
				pending = map[string]bool{}
			}
		}
	}()
	return nil
}

// addTree watches dir and every directory below it that isn't skipped.
func (s *Server) addTree(w *fsnotify.Watcher, dir string, sk *skipper) {
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if rel, _ := filepath.Rel(s.root, p); rel != "." && sk.skip(filepath.ToSlash(rel)) {
			return filepath.SkipDir
		}
		if err := w.Add(p); err != nil {
			s.log.Printf("watch %s: %v", p, err)
		}
		return nil
	})
}

// apply handles one debounced batch of changed paths.
func (s *Server) apply(paths []string) {
	var projFiles, srcFiles []string
	rebuild := false
	prefix := project.Dir + "/"
	for _, p := range paths {
		switch {
		case p == project.Dir:
			projFiles = append(projFiles, p)
		case strings.HasPrefix(p, prefix):
			name := strings.TrimPrefix(p, prefix)
			projFiles = append(projFiles, name)
			// Declared nodes are merged into the graph, and config drives the extractors.
			if name == "external.toml" || name == "config.toml" {
				rebuild = true
			}
		default:
			srcFiles = append(srcFiles, p)
			rebuild = true
		}
	}
	if len(projFiles) > 0 {
		data := EventData{Files: projFiles}
		if err := s.reloadProject(); err != nil {
			s.log.Printf("reload .codemap: %v (serving the last good state)", err)
			data.Error = err.Error()
		}
		s.events.publish(Event{Name: "project-changed", Data: data})
	}
	if rebuild {
		files := srcFiles
		if files == nil {
			files = []string{}
			for _, f := range projFiles {
				files = append(files, prefix+f)
			}
		}
		data := EventData{Files: files}
		if err := s.rebuildGraph(); err != nil {
			s.log.Printf("rebuild: %v (serving the last good graph)", err)
			data.Error = err.Error()
		}
		s.events.publish(Event{Name: "graph-changed", Data: data})
	}
}

// skipper decides which repo-relative paths the watcher ignores.
type skipper struct {
	root    string
	exclude []string
	ignored map[string]bool // gitignored directories, slash-separated, no trailing slash
}

func (k *skipper) skip(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".git" || seg == "node_modules" {
			return true
		}
	}
	for d := rel; d != "." && d != "/" && d != ""; d = path.Dir(d) {
		if k.ignored[d] {
			return true
		}
	}
	for _, g := range k.exclude {
		if globMatch(g, rel) || globMatch(strings.TrimSuffix(g, "/**"), rel) {
			return true
		}
	}
	return false
}

// gitIgnoredDirs lists the gitignored directories under root, if it is in a git repo.
func gitIgnoredDirs(root string) map[string]bool {
	out, err := exec.Command("git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory").Output()
	dirs := map[string]bool{}
	if err != nil {
		return dirs
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasSuffix(line, "/") {
			dirs[strings.TrimSuffix(line, "/")] = true
		}
	}
	return dirs
}

// globMatch is path.Match where "**" matches across slashes (as in project.BlockFor).
func globMatch(pattern, s string) bool {
	if !strings.Contains(pattern, "**") {
		ok, _ := path.Match(pattern, s)
		return ok
	}
	parts := strings.SplitN(pattern, "**", 2)
	prefix, rest := parts[0], strings.TrimPrefix(parts[1], "/")
	if !strings.HasPrefix(s, prefix) {
		return false
	}
	tail := strings.TrimPrefix(s, prefix)
	if rest == "" {
		return true
	}
	segs := strings.Split(tail, "/")
	for i := range segs {
		if globMatch(rest, strings.Join(segs[i:], "/")) {
			return true
		}
	}
	return false
}
