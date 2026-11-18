package goext

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// tableFields extracts root and returns each table's columns and sources as JSON.
func tableFields(t *testing.T, root string) map[string]string {
	t.Helper()
	g, err := Extract(root, project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	out := map[string]string{}
	for _, n := range g.Nodes {
		if n.Kind != graph.KindTable {
			continue
		}
		b, _ := json.Marshal(n.Fields)
		out[strings.TrimPrefix(n.ID, "table:")] = string(b)
	}
	return out
}

func checkTables(t *testing.T, got, want map[string]string) {
	t.Helper()
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s:\n got %s\nwant %s", name, got[name], w)
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			t.Errorf("unexpected table %s: %s", name, got[name])
		}
	}
}

// TestDDLInGo checks that CREATE/ALTER TABLE in Go string constants give
// tables their columns, applied in file and position order, and that
// migrations win over them.
func TestDDLInGo(t *testing.T) {
	checkTables(t, tableFields(t, "testdata/ddl"), map[string]string{
		// Defined by a migration: the Go copy is ignored.
		"account": `{"columns":[["id","bigserial","pk"],["email","text","unique"]],"source":["migrations/001_init.sql"]}`,
		// archived comes from upgrade.go, read after schema.go.
		"project": `{"columns":[["id","integer","pk"],["owner","integer","→ account.id"],["name","text","unique"],["archived","integer",""]],"source":["store/schema.go","store/upgrade.go"]}`,
		// A constant concatenated from pieces.
		"tag": `{"columns":[["id","integer","pk"],["task","integer","→ task.id"]],"source":["store/schema.go"]}`,
		// Rebuilt by the second migration string (SQLite's copy-and-rename).
		"task": `{"columns":[["id","integer","pk"],["project","integer",""],["title","text",""],["done","integer",""]],"source":["store/schema.go"]}`,
	})
}

// TestORMColumns checks the columns ORM models give their tables: tag and
// convention names, skipped and embedded fields, primary keys, and
// relationships by XxxID and by fields holding other models.
func TestORMColumns(t *testing.T) {
	src := `"source":["app/models/models.go"]`
	checkTables(t, tableFields(t, "testdata/orm"), map[string]string{
		"issue": `{"columns":[` +
			`["id","int64","pk"],` +
			`["repo_id","int64","→ repository.id"],` + // through the Repo field tagged "-"
			`["idx","int64",""],` + // xorm 'name'
			`["title","string",""],` + // an unquoted xorm word isn't a name
			`["label_id","int64","→ label.id"],` + // a table named label
			`["milestone_id","int64",""],` +
			`["created","timeutil.TimeStamp",""],` +
			`["updated_unix","timeutil.TimeStamp",""]],` + // embedded Stamps
			src + `}`,
		"comment": `{"columns":[["cid","int64","pk"],["issue_id","int64","→ issue.id"],["repo_id","int64","→ repository.id"]],` + src + `}`,
		// DDL in a Go constant wins over the struct.
		"label":      `{"columns":[["id","integer","pk"],["name","text","unique"]],"source":["app/models/models.go"]}`,
		"repository": `{"columns":[["id","int64","pk"]],` + src + `}`,
		"users": `{"columns":[` +
			`["id","uint","pk"],["created_at","time.Time",""],` + // gorm.Model flattened
			`["full_name","string",""],` + // gorm column:
			`["category_id","uint","→ categories.code"],` + // plural convention; the key Category declares
			`["category","*Category","→ categories"]],` + // a relation field
			src + `}`,
		"categories":    `{"columns":[["code","string","pk"],["id","int64",""]],` + src + `}`,
		"library_books": `{"columns":[["id","int64","pk"],["book_title","string",""],["author_id","int64","→ users.id"],["author","*User","→ users"]],` + src + `}`,
		"login_source":  `{"columns":[["id","int64","pk"]],` + src + `}`,
		// Named only by Table("…"): no model, no columns.
		"order_totals": `null`,
	})
}
