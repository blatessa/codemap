package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"codemap/internal/project"
)

// setup copies testdata/shop and shop.expected.json into a temp dir and
// starts a server on it.
func setup(t *testing.T) (*Server, *httptest.Server, string) {
	t.Helper()
	tmp := t.TempDir()
	root := filepath.Join(tmp, "shop")
	if err := os.CopyFS(root, os.DirFS("../../testdata/shop")); err != nil {
		t.Fatal(err)
	}
	// Viewer state from trying the fixture locally isn't part of it.
	for _, f := range []string{"blocks.toml"} {
		os.Remove(filepath.Join(root, ".codemap", f))
	}
	b, err := os.ReadFile("../../testdata/shop.expected.json")
	if err != nil {
		t.Fatal(err)
	}
	graphFile := filepath.Join(tmp, "shop.expected.json")
	if err := os.WriteFile(graphFile, b, 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(Options{Root: root, GraphFile: graphFile, Debounce: 50 * time.Millisecond, Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	s.gitHead = func() string { return "3f2c9e1" }
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts, root
}

type resp struct {
	status int
	body   []byte
}

func (r resp) decode(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("decode %s: %v", r.body, err)
	}
}

func do(t *testing.T, ts *httptest.Server, method, path string, body any, hdr ...string) resp {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, ts.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		if hdr[i] == "Host" {
			req.Host = hdr[i+1]
		} else {
			req.Header.Set(hdr[i], hdr[i+1])
		}
	}
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return resp{res.StatusCode, b}
}

type state struct {
	Graph struct {
		Rev   string            `json:"rev"`
		Nodes []json.RawMessage `json:"nodes"`
	} `json:"graph"`
	Project  project.Project   `json:"project"`
	Versions map[string]string `json:"versions"`
}

func getState(t *testing.T, ts *httptest.Server) state {
	t.Helper()
	r := do(t, ts, "GET", "/api/state", nil)
	if r.status != 200 {
		t.Fatalf("state: %d %s", r.status, r.body)
	}
	var st state
	r.decode(t, &st)
	return st
}

func diskVersion(t *testing.T, root, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, ".codemap", name))
	if err != nil {
		return Missing
	}
	return version(b)
}

func TestState(t *testing.T) {
	_, ts, root := setup(t)
	st := getState(t, ts)
	if st.Graph.Rev != "worktree" || len(st.Graph.Nodes) == 0 {
		t.Errorf("graph: rev=%q nodes=%d", st.Graph.Rev, len(st.Graph.Nodes))
	}
	if len(st.Project.Areas) != 5 || len(st.Project.Proposals) != 2 || st.Project.Proposals[1].Body == "" {
		t.Errorf("project: %+v", st.Project)
	}
	if st.Project.Blocks == nil {
		t.Error("empty lists should be [] / {}, not null")
	}
	want := map[string]string{
		"areas":                  diskVersion(t, root, "areas.toml"),
		"blocks":                 Missing,
		"external":               diskVersion(t, root, "external.toml"),
		"proposals/refunds":      diskVersion(t, root, "proposals/refunds.md"),
		"proposals/order-search": diskVersion(t, root, "proposals/order-search.md"),
	}
	if !reflect.DeepEqual(st.Versions, want) {
		t.Errorf("versions = %v, want %v", st.Versions, want)
	}
	if r := do(t, ts, "GET", "/api/state?rev=worktree", nil); r.status != 200 {
		t.Errorf("rev=worktree: %d", r.status)
	}
	if r := do(t, ts, "GET", "/api/state?rev=abc123", nil); r.status != 501 || !strings.Contains(string(r.body), "worktree") {
		t.Errorf("rev=abc123: %d %s", r.status, r.body)
	}
	if r := do(t, ts, "GET", "/api/nope", nil); r.status != 404 {
		t.Errorf("unknown endpoint: %d", r.status)
	}
}

func TestProjectRoundTrip(t *testing.T) {
	cases := []struct {
		name, file string
		value      any
		want       func(p *project.Project) any
	}{
		{"areas", "areas.toml",
			[]project.Area{{Name: "Commerce", Modules: []string{"mod:go:shop/internal/orders"}}},
			func(p *project.Project) any { return p.Areas }},
		{"blocks", "blocks.toml",
			[]project.Block{{ID: "block:pages-checkout", Name: "pages · checkout", From: "mod:ts:web/src/pages", Match: []string{"/checkout*"}}},
			func(p *project.Project) any { return p.Blocks }},
		{"external", "external.toml",
			project.External{
				Nodes: []map[string]any{{"id": "ext:stripe", "owner": "Someone else"}},
				Edges: []project.ExternalEdge{{From: "ext:stripe", To: "route:POST /webhooks/stripe", Detail: "events"}},
			},
			func(p *project.Project) any { return p.External }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, ts, root := setup(t)
			before := getState(t, ts).Versions[c.name]

			if r := do(t, ts, "PUT", "/api/project/"+c.name, c.value); r.status != 428 {
				t.Errorf("no If-Match: %d %s", r.status, r.body)
			}
			r := do(t, ts, "PUT", "/api/project/"+c.name, c.value, "If-Match", before)
			if r.status != 200 {
				t.Fatalf("put: %d %s", r.status, r.body)
			}
			var v struct{ Version string }
			r.decode(t, &v)
			if v.Version == before || v.Version != diskVersion(t, root, c.file) {
				t.Errorf("version %q, before %q, disk %q", v.Version, before, diskVersion(t, root, c.file))
			}
			disk, err := project.Load(root)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(c.want(disk), c.value) {
				t.Errorf("on disk: %#v\nwant %#v", c.want(disk), c.value)
			}
			st := getState(t, ts)
			if st.Versions[c.name] != v.Version {
				t.Errorf("state version %q, want %q", st.Versions[c.name], v.Version)
			}
			if c.name == "areas" && len(st.Project.Areas) != 1 {
				t.Errorf("state not refreshed: %+v", st.Project.Areas)
			}

			// A stale If-Match conflicts and returns what's on disk.
			r = do(t, ts, "PUT", "/api/project/"+c.name, c.value, "If-Match", before)
			if r.status != 409 {
				t.Fatalf("stale: %d %s", r.status, r.body)
			}
			var cf struct {
				Version string
				Value   json.RawMessage
			}
			r.decode(t, &cf)
			if cf.Version != v.Version {
				t.Errorf("409 version %q, want %q", cf.Version, v.Version)
			}
			wantJSON, _ := json.Marshal(c.value)
			if !jsonEqual(t, cf.Value, wantJSON) {
				t.Errorf("409 value %s, want %s", cf.Value, wantJSON)
			}
			if r := do(t, ts, "PUT", "/api/project/"+c.name+"?rev=abc", c.value, "If-Match", v.Version); r.status != 405 {
				t.Errorf("write at rev: %d", r.status)
			}
		})
	}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}

func TestExternalWriteUpdatesGraph(t *testing.T) {
	_, ts, _ := setup(t)
	v := getState(t, ts).Versions["external"]
	ext := project.External{Nodes: []map[string]any{{"id": "ext:stripe", "owner": "Billing"}}}
	if r := do(t, ts, "PUT", "/api/project/external", ext, "If-Match", v); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.body)
	}
	r := do(t, ts, "GET", "/api/state", nil)
	if !strings.Contains(string(r.body), `"owner":"Billing"`) {
		t.Error("declared fields should be re-merged into the graph")
	}
}

func TestConflictAfterDiskEdit(t *testing.T) {
	_, ts, root := setup(t)
	v := getState(t, ts).Versions["areas"]
	if err := os.WriteFile(filepath.Join(root, ".codemap/areas.toml"), []byte("[[area]]\nname = \"Agent\"\nmodules = [\"mod:x\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := do(t, ts, "PUT", "/api/project/areas", []project.Area{{Name: "Mine"}}, "If-Match", v)
	if r.status != 409 {
		t.Fatalf("%d %s", r.status, r.body)
	}
	var cf struct {
		Version string
		Value   []project.Area
	}
	r.decode(t, &cf)
	if cf.Version != diskVersion(t, root, "areas.toml") || len(cf.Value) != 1 || cf.Value[0].Name != "Agent" {
		t.Errorf("409: %+v", cf)
	}
	// Creating a missing file uses the "missing" version.
	if r := do(t, ts, "PUT", "/api/project/blocks", []project.Block{}, "If-Match", Missing); r.status != 200 {
		t.Errorf("create blocks: %d %s", r.status, r.body)
	}
	if r := do(t, ts, "PUT", "/api/project/bogus", []any{}, "If-Match", Missing); r.status != 404 {
		t.Errorf("bogus: %d", r.status)
	}
	if r := do(t, ts, "PUT", "/api/project/areas", map[string]any{"not": "a list"}, "If-Match", Missing); r.status != 400 {
		t.Errorf("bad body: %d", r.status)
	}
}

func TestBlockIDFilled(t *testing.T) {
	_, ts, root := setup(t)
	if r := do(t, ts, "PUT", "/api/project/blocks", []project.Block{{Name: "pages · checkout", From: "mod:ts:web/src/pages"}}, "If-Match", Missing); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.body)
	}
	p, _ := project.Load(root)
	if len(p.Blocks) != 1 || p.Blocks[0].ID != "block:pages-checkout" {
		t.Errorf("%+v", p.Blocks)
	}
}

func TestProposals(t *testing.T) {
	_, ts, root := setup(t)
	file := filepath.Join(root, ".codemap/proposals/stock-events.md")

	r := do(t, ts, "GET", "/api/proposals", nil)
	var list []project.Proposal
	r.decode(t, &list)
	if r.status != 200 || len(list) != 2 || list[1].Slug != "refunds" || !strings.Contains(list[1].Body, "##") {
		t.Fatalf("list: %d %+v", r.status, list)
	}

	// Create.
	p := project.Proposal{
		Name:  "Stock via events",
		Nodes: []map[string]any{{"id": "new:x", "kind": "function", "label": "X", "module": "mod:go:shop/internal/inventory"}},
		Edges: []map[string]any{{"from": "new:x", "to": "topic:order.placed"}},
		Body:  "## Why\nDecouple.\n",
	}
	r = do(t, ts, "PUT", "/api/proposals/stock-events", p)
	if r.status != 200 {
		t.Fatalf("create: %d %s", r.status, r.body)
	}
	var v1 struct{ Version string }
	r.decode(t, &v1)
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	got, err := project.ParseProposal(b)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(b), "+++\n") || got.Name != "Stock via events" || got.Status != "open" ||
		got.Base != "3f2c9e1" || got.Updated == "" || got.Body != p.Body || len(got.Nodes) != 1 || len(got.Edges) != 1 {
		t.Errorf("created file:\n%s", b)
	}
	if v1.Version != version(b) {
		t.Errorf("version %q, disk %q", v1.Version, version(b))
	}
	if st := getState(t, ts); st.Versions["proposals/stock-events"] != v1.Version || len(st.Project.Proposals) != 3 {
		t.Errorf("state after create: %v", st.Versions)
	}

	// Overwriting needs If-Match.
	p.Body = "## Why\nChanged.\n"
	p.Base = got.Base
	if r := do(t, ts, "PUT", "/api/proposals/stock-events", p); r.status != 428 {
		t.Errorf("no If-Match: %d", r.status)
	}
	r = do(t, ts, "PUT", "/api/proposals/stock-events", p, "If-Match", v1.Version)
	if r.status != 200 {
		t.Fatalf("update: %d %s", r.status, r.body)
	}
	var v2 struct{ Version string }
	r.decode(t, &v2)
	b, _ = os.ReadFile(file)
	if !strings.Contains(string(b), "Changed.") || strings.Contains(string(b), "Decouple.") || v2.Version != version(b) {
		t.Errorf("updated file:\n%s", b)
	}

	// Stale.
	r = do(t, ts, "PUT", "/api/proposals/stock-events", p, "If-Match", v1.Version)
	var cf struct {
		Version string
		Value   project.Proposal
	}
	r.decode(t, &cf)
	if r.status != 409 || cf.Version != v2.Version || cf.Value.Slug != "stock-events" || cf.Value.Body != p.Body {
		t.Errorf("stale: %d %s", r.status, r.body)
	}
	// Creating over a proposal that someone deleted conflicts.
	if r := do(t, ts, "PUT", "/api/proposals/gone", p, "If-Match", v1.Version); r.status != 409 {
		t.Errorf("gone: %d", r.status)
	}
	for _, slug := range []string{"..", ".hidden", "a%2Fb", "..%2Fx"} {
		if r := do(t, ts, "PUT", "/api/proposals/"+slug, p); r.status < 400 {
			t.Errorf("bad slug %s: %d", slug, r.status)
		}
	}
	if m, _ := filepath.Glob(filepath.Join(root, ".codemap/*.md")); len(m) > 0 {
		t.Errorf("wrote outside proposals/: %v", m)
	}
	if r := do(t, ts, "PUT", "/api/proposals/stock-events?rev=abc", p, "If-Match", v2.Version); r.status != 405 {
		t.Errorf("write at rev: %d", r.status)
	}

	// Delete.
	if r := do(t, ts, "DELETE", "/api/proposals/stock-events", nil, "If-Match", v1.Version); r.status != 409 {
		t.Errorf("stale delete: %d", r.status)
	}
	if r := do(t, ts, "DELETE", "/api/proposals/stock-events?rev=abc", nil); r.status != 405 {
		t.Errorf("delete at rev: %d", r.status)
	}
	if r := do(t, ts, "DELETE", "/api/proposals/stock-events", nil); r.status != 204 {
		t.Fatalf("delete: %d %s", r.status, r.body)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Error("file still exists")
	}
	if r := do(t, ts, "DELETE", "/api/proposals/stock-events", nil); r.status != 404 {
		t.Errorf("delete again: %d", r.status)
	}
	if st := getState(t, ts); len(st.Project.Proposals) != 2 || st.Versions["proposals/stock-events"] != "" {
		t.Errorf("state after delete: %v", st.Versions)
	}
}

func TestSource(t *testing.T) {
	_, ts, root := setup(t)
	r := do(t, ts, "GET", "/api/source?file=internal/orders/service.go&from=2&to=4", nil)
	if r.status != 200 {
		t.Fatalf("%d %s", r.status, r.body)
	}
	var src struct {
		File  string
		From  int
		Lines []string
	}
	r.decode(t, &src)
	b, _ := os.ReadFile(filepath.Join(root, "internal/orders/service.go"))
	all := strings.Split(string(b), "\n")
	if src.File != "internal/orders/service.go" || src.From != 2 || !reflect.DeepEqual(src.Lines, all[1:4]) {
		t.Errorf("source: %+v", src)
	}
	r = do(t, ts, "GET", "/api/source?file=go.mod", nil)
	r.decode(t, &src)
	if r.status != 200 || src.From != 1 || len(src.Lines) == 0 {
		t.Errorf("whole file: %d %+v", r.status, src)
	}

	outside := filepath.Join(filepath.Dir(root), "secret.txt")
	os.WriteFile(outside, []byte("secret\n"), 0o644)
	if err := os.Symlink(outside, filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"../secret.txt", "internal/../../secret.txt", outside, "link.txt", "/etc/passwd"} {
		r := do(t, ts, "GET", "/api/source?file="+f, nil)
		if r.status != 403 || strings.Contains(string(r.body), "secret\"") {
			t.Errorf("%s: %d %s", f, r.status, r.body)
		}
	}
	if r := do(t, ts, "GET", "/api/source?file=nope.go", nil); r.status != 404 {
		t.Errorf("missing: %d", r.status)
	}
	if r := do(t, ts, "GET", "/api/source?file=go.mod&rev=abc", nil); r.status != 501 {
		t.Errorf("rev: %d", r.status)
	}
}

func TestHostAndOrigin(t *testing.T) {
	_, ts, _ := setup(t)
	for _, h := range []string{"evil.example", "evil.example:7777", "127.0.0.1.evil.example"} {
		if r := do(t, ts, "GET", "/api/state", nil, "Host", h); r.status != 403 {
			t.Errorf("Host %s: %d", h, r.status)
		}
	}
	for _, h := range []string{"localhost:7777", "127.0.0.1:7777", "[::1]:7777", "localhost"} {
		if r := do(t, ts, "GET", "/api/state", nil, "Host", h); r.status != 200 {
			t.Errorf("Host %s: %d", h, r.status)
		}
	}
	areas := []project.Area{{Name: "A"}}
	if r := do(t, ts, "PUT", "/api/project/areas", areas, "If-Match", "x", "Origin", "http://evil.example"); r.status != 403 {
		t.Errorf("cross-origin write: %d", r.status)
	}
	if r := do(t, ts, "POST", "/api/open", map[string]any{"file": "go.mod"}, "Origin", "null"); r.status != 403 {
		t.Errorf("null origin: %d", r.status)
	}
	// Same origin passes the guard and reaches the handler (here a 409).
	if r := do(t, ts, "PUT", "/api/project/areas", areas, "If-Match", "x", "Origin", ts.URL); r.status != 409 {
		t.Errorf("same-origin write: %d %s", r.status, r.body)
	}
	// Cross-origin reads are allowed through (the browser won't expose them without CORS).
	if r := do(t, ts, "GET", "/api/state", nil, "Origin", "http://evil.example"); r.status != 200 {
		t.Errorf("read with origin: %d", r.status)
	}
}

func TestOpen(t *testing.T) {
	s, ts, root := setup(t)
	var got []string
	s.startCmd = func(c *exec.Cmd) error { got = c.Args; return nil }

	t.Setenv("VISUAL", "code --wait")
	t.Setenv("EDITOR", "other")
	if r := do(t, ts, "POST", "/api/open", map[string]any{"file": "internal/orders/service.go", "line": 19}); r.status != 204 {
		t.Fatalf("%d %s", r.status, r.body)
	}
	abs := filepath.Join(root, "internal/orders/service.go")
	if want := []string{"code", "--wait", "-g", abs + ":19"}; !reflect.DeepEqual(got, want) {
		t.Errorf("args %q, want %q", got, want)
	}

	cfg := filepath.Join(root, ".codemap/config.toml")
	b, _ := os.ReadFile(cfg)
	os.WriteFile(cfg, append([]byte("editor = \"code -g {file}:{line}\"\n"), b...), 0o644) // top-level keys go before the tables
	if err := s.reloadProject(); err != nil {
		t.Fatal(err)
	}
	if r := do(t, ts, "POST", "/api/open", map[string]any{"file": "internal/orders/service.go", "line": 7}); r.status != 204 {
		t.Fatalf("%d %s", r.status, r.body)
	}
	if want := []string{"code", "-g", abs + ":7"}; !reflect.DeepEqual(got, want) {
		t.Errorf("args %q, want %q", got, want)
	}

	got = nil
	for _, f := range []string{"../shop.expected.json", "/etc/passwd"} {
		if r := do(t, ts, "POST", "/api/open", map[string]any{"file": f, "line": 1}); r.status != 403 || got != nil {
			t.Errorf("%s: %d", f, r.status)
		}
	}
	if r := do(t, ts, "POST", "/api/open?rev=abc", map[string]any{"file": "go.mod"}); r.status != 405 {
		t.Errorf("rev: %d", r.status)
	}
	if r := do(t, ts, "PUT", "/api/open", nil); r.status != 405 {
		t.Errorf("PUT open: %d", r.status)
	}
}

func TestEditorArgs(t *testing.T) {
	t.Setenv("VISUAL", "")
	t.Setenv("EDITOR", "")
	if _, err := editorArgs("", "/f", 1); err == nil {
		t.Error("expected an error without any editor")
	}
	got, _ := editorArgs("subl", "/a b/f.go", 3)
	if !reflect.DeepEqual(got, []string{"subl", "/a b/f.go"}) {
		t.Errorf("%q", got)
	}

	term := func() []string { return []string{"xdg-terminal-exec"} }
	cases := []struct {
		ed   []string
		want []string
	}{
		{[]string{"code"}, []string{"code", "-g", "/f.go:3"}},
		{[]string{"nvim"}, []string{"xdg-terminal-exec", "nvim", "+3", "/f.go"}},
		{[]string{"/usr/bin/hx"}, []string{"xdg-terminal-exec", "/usr/bin/hx", "/f.go:3"}},
		{[]string{"my-launcher", "--inline"}, []string{"xdg-terminal-exec", "my-launcher", "--inline", "/f.go"}},
	}
	for _, c := range cases {
		got, err := defaultEditorArgs(c.ed, "/f.go", 3, term)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: got %q, %v", c.ed, got, err)
		}
	}
	if _, err := defaultEditorArgs([]string{"vim"}, "/f", 1, func() []string { return nil }); err == nil {
		t.Error("expected an error without a terminal")
	}
}

func TestAssets(t *testing.T) {
	s, ts, _ := setup(t)
	if r := do(t, ts, "GET", "/", nil); r.status != 200 || !strings.Contains(string(r.body), "codemap") {
		t.Errorf("placeholder: %d", r.status)
	}
	s2, err := New(Options{Root: s.root, GraphFile: s.graphFile, Logger: s.log, Assets: fstest.MapFS{
		"dist/index.html":       {Data: []byte("<html>viewer</html>")},
		"dist/assets/app.js":    {Data: []byte("console.log(1)")},
		"dist/assets/sub/x.css": {Data: []byte("body{}")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	ts2 := httptest.NewServer(s2.Handler())
	defer ts2.Close()
	if r := do(t, ts2, "GET", "/assets/app.js", nil); r.status != 200 || string(r.body) != "console.log(1)" {
		t.Errorf("asset: %d %s", r.status, r.body)
	}
	for _, p := range []string{"/", "/index.html", "/orders/12", "/assets"} {
		if r := do(t, ts2, "GET", p, nil); r.status != 200 || string(r.body) != "<html>viewer</html>" {
			t.Errorf("%s: %d %s", p, r.status, r.body)
		}
	}
	if r := do(t, ts2, "GET", "/api/missing", nil); r.status != 404 {
		t.Errorf("api 404: %d", r.status)
	}
}

// sse reads events from /api/events.
type sse struct {
	ch chan Event
}

func openEvents(t *testing.T, ts *httptest.Server) *sse {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/events", nil)
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	s := &sse{ch: make(chan Event, 32)}
	connected := make(chan bool)
	go func() {
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		var ev Event
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, ": connected"):
				close(connected)
			case strings.HasPrefix(line, "event: "):
				ev.Name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev.Data)
			case line == "" && ev.Name != "":
				s.ch <- ev
				ev = Event{}
			}
		}
	}()
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("no connected comment")
	}
	return s
}

func (s *sse) wait(t *testing.T, name string) Event {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev := <-s.ch:
			if ev.Name == name {
				return ev
			}
		case <-timeout:
			t.Fatalf("no %s event", name)
		}
	}
}

func TestEvents(t *testing.T) {
	s, ts, root := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Watch(ctx); err != nil {
		t.Fatal(err)
	}
	ev := openEvents(t, ts)

	// Editing a .codemap file reloads the project.
	os.WriteFile(filepath.Join(root, ".codemap/areas.toml"), []byte("[[area]]\nname = \"Only\"\nmodules = []\n"), 0o644)
	e := ev.wait(t, "project-changed")
	if !reflect.DeepEqual(e.Data.Files, []string{"areas.toml"}) || e.Data.Error != "" {
		t.Errorf("project-changed: %+v", e.Data)
	}
	if st := getState(t, ts); len(st.Project.Areas) != 1 || st.Project.Areas[0].Name != "Only" {
		t.Errorf("areas after edit: %+v", st.Project.Areas)
	}

	// A broken file keeps the last good state and reports the error.
	os.WriteFile(filepath.Join(root, ".codemap/areas.toml"), []byte("[[area]]\nname = [unclosed\n"), 0o644)
	e = ev.wait(t, "project-changed")
	if e.Data.Error == "" {
		t.Errorf("expected an error: %+v", e.Data)
	}
	if st := getState(t, ts); len(st.Project.Areas) != 1 {
		t.Errorf("should keep last good areas: %+v", st.Project.Areas)
	}

	// Fix it again before the next steps.
	os.WriteFile(filepath.Join(root, ".codemap/areas.toml"), []byte("[[area]]\nname = \"Only\"\nmodules = []\n"), 0o644)
	ev.wait(t, "project-changed")

	// A new directory is watched too.
	os.MkdirAll(filepath.Join(root, "internal/newpkg"), 0o755)
	ev.wait(t, "graph-changed")
	os.WriteFile(filepath.Join(root, "internal/newpkg/a.go"), []byte("package newpkg\n"), 0o644)
	if e := ev.wait(t, "graph-changed"); !reflect.DeepEqual(e.Data.Files, []string{"internal/newpkg/a.go"}) {
		t.Errorf("new dir: %+v", e.Data)
	}

	// Touching a Go file rebuilds the graph.
	f := filepath.Join(root, "internal/orders/service.go")
	b, _ := os.ReadFile(f)
	os.WriteFile(f, append(b, []byte("\n// touched\n")...), 0o644)
	e = ev.wait(t, "graph-changed")
	if !reflect.DeepEqual(e.Data.Files, []string{"internal/orders/service.go"}) || e.Data.Error != "" {
		t.Errorf("graph-changed: %+v", e.Data)
	}

	// A broken graph keeps the last good graph and reports the error.
	os.WriteFile(s.graphFile, []byte("{not json"), 0o644)
	e = ev.wait(t, "graph-changed")
	if e.Data.Error == "" {
		t.Errorf("expected a rebuild error: %+v", e.Data)
	}
	if st := getState(t, ts); len(st.Graph.Nodes) == 0 {
		t.Error("should keep the last good graph")
	}

	// node_modules is ignored.
	os.MkdirAll(filepath.Join(root, "web/node_modules/x"), 0o755)
	os.WriteFile(filepath.Join(root, "web/node_modules/x/a.js"), []byte("1"), 0o644)
	select {
	case e := <-ev.ch:
		t.Errorf("unexpected event %+v", e)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestSkipper(t *testing.T) {
	k := &skipper{exclude: []string{"vendor/**", "**/*_gen.go"}, ignored: map[string]bool{"web/dist": true}}
	for p, want := range map[string]bool{
		".git": true, ".git/HEAD": true, "web/node_modules/a": true, "vendor": true, "vendor/x/y.go": true,
		"a/b_gen.go": true, "web/dist/x.js": true, "web/src/a.ts": false, "internal/orders/service.go": false,
	} {
		if got := k.skip(p); got != want {
			t.Errorf("skip(%q) = %v", p, got)
		}
	}
}
