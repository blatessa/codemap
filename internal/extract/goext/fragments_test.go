package goext

import (
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// TestSQLFragments: queries assembled from constant fragments, and a complete
// UPDATE passed through a helper that isn't a DB method.
func TestSQLFragments(t *testing.T) {
	g, err := Extract("testdata/fragments", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	var got []string
	for _, e := range g.Edges {
		if e.Type == graph.Reads || e.Type == graph.Writes {
			got = append(got, fmt.Sprintf("%s %s %s | %s:%d | %s", strings.TrimPrefix(e.From, "go:fragments/store."), e.Type, e.To, e.File, e.Line, e.Detail))
		}
	}
	sort.Strings(got)
	want := []string{
		// strings.Builder
		"(*EntryQueryBuilder).Count reads table:entries | store/store.go:49 | FROM entries e",
		"(*EntryQueryBuilder).Count reads table:feeds | store/store.go:50 | LEFT JOIN feeds f ON f.id = e.feed_id",
		// a local passed to fmt.Sprintf
		"(*EntryQueryBuilder).GetEntries reads table:entries | store/store.go:38 | SELECT e.id, f.title FROM entries e LEFT JOIN feeds f ON f.id = e.feed_id WHERE %s %s",
		"(*EntryQueryBuilder).GetEntries reads table:feeds | store/store.go:38 | SELECT e.id, f.title FROM entries e LEFT JOIN feeds f ON f.id = e.feed_id WHERE %s %s",
		// a subquery fragment; WithStars' "stars" isn't a known table
		"(*EntryQueryBuilder).WithActiveUsers reads table:users | store/store.go:27 | e.user_id IN (SELECT id FROM users WHERE active)",
		// the DB method path, without a second detail
		"(*Storage).DeleteFeed writes table:feeds | store/store.go:68 | DELETE FROM feeds WHERE id=$1",
		// complete statements through a helper that isn't a DB method
		"(*Storage).Prune writes table:audit_log | store/store.go:61 | DELETE FROM audit_log WHERE ts < now()",
		"(*Storage).UpdateTitle writes table:entries | store/store.go:56 | UPDATE entries SET title=$1 WHERE id=$2",
		// nothing from Cached's messages, though cache is a known table
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\n\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	var tables []string
	for _, n := range g.Nodes {
		if n.Kind == graph.KindTable {
			tables = append(tables, n.ID)
		}
	}
	sort.Strings(tables)
	if s := strings.Join(tables, " "); s != "table:audit_log table:cache table:entries table:feeds table:users" {
		t.Errorf("tables: %s", s)
	}
}
