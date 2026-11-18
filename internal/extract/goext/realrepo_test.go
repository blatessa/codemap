package goext

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// TestRealRepos runs the extractor on repos listed in CODEMAP_REAL_REPOS
// (colon-separated paths) and reports counts. It checks the graph is valid and
// has modules and nodes; set CODEMAP_EXPECT_ROUTES=1 to also require routes,
// and CODEMAP_DUMP=<dir> to write each graph to <dir>/<repo>.json.
//
//	CODEMAP_REAL_REPOS=/tmp/chi-app:/tmp/gin-app go test ./internal/extract/goext -run TestRealRepos -v
func TestRealRepos(t *testing.T) {
	env := os.Getenv("CODEMAP_REAL_REPOS")
	if env == "" {
		t.Skip("set CODEMAP_REAL_REPOS to run")
	}
	for _, root := range filepath.SplitList(env) {
		t.Run(filepath.Base(root), func(t *testing.T) {
			proj, err := project.Load(root)
			if err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			g, err := Extract(root, proj.Config)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("extracted in %v", time.Since(start).Round(time.Millisecond))
			for _, e := range graph.Validate(g) {
				t.Error(e)
			}
			if dir := os.Getenv("CODEMAP_DUMP"); dir != "" {
				f, err := os.Create(filepath.Join(dir, filepath.Base(root)+".json"))
				if err != nil {
					t.Fatal(err)
				}
				g.Encode(f)
				f.Close()
			}
			kinds := map[string]int{}
			for _, n := range g.Nodes {
				kinds[n.Kind]++
			}
			types := map[string]int{}
			for _, e := range g.Edges {
				types[e.Type]++
			}
			t.Logf("modules %d, nodes %d %v, edges %d %v", len(g.Modules), len(g.Nodes), sortedCounts(kinds), len(g.Edges), sortedCounts(types))
			var routes, ext []string
			for _, n := range g.Nodes {
				switch n.Kind {
				case graph.KindRoute:
					routes = append(routes, strings.TrimPrefix(n.ID, "route:"))
				case graph.KindService, graph.KindTable, graph.KindTopic, graph.KindJob, graph.KindSubscriber:
					ext = append(ext, n.ID)
				}
			}
			sort.Strings(routes)
			for _, r := range routes {
				t.Logf("  route %s", r)
			}
			for _, x := range ext {
				t.Logf("  %s", x)
			}
			if len(g.Modules) == 0 || len(g.Nodes) == 0 {
				t.Error("no modules or nodes")
			}
			if os.Getenv("CODEMAP_EXPECT_ROUTES") != "" && kinds[graph.KindRoute] == 0 {
				t.Error("no routes")
			}
		})
	}
}

func sortedCounts(m map[string]int) string {
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteString(" ")
		}
		b.WriteString(k + ":" + itoa(m[k]))
	}
	return "{" + b.String() + "}"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d []byte
	for ; n > 0; n /= 10 {
		d = append([]byte{byte('0' + n%10)}, d...)
	}
	return string(d)
}
