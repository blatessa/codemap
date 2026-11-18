package goext

import (
	"sort"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// TestORM checks that reads and writes made through xorm, gorm and bun reach
// the model's table, including through the repo's own wrappers.
func TestORM(t *testing.T) {
	g, err := Extract("testdata/orm", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	var got []string
	for _, e := range g.Edges {
		if e.Type == graph.Reads || e.Type == graph.Writes {
			from := e.From[strings.LastIndex(e.From, ".")+1:]
			got = append(got, from+" "+e.Type+" "+strings.TrimPrefix(e.To, "table:"))
		}
	}
	sort.Strings(got)
	want := []string{
		"AddBook writes library_books",  // bun table tag
		"AddCategory writes categories", // gorm: plural
		"AddLabel writes label",         // through the repo's interface over xorm
		"CountIssues reads issue",       // session in a local variable
		"CountLabels reads label",       // not the *Ctx passed to the root
		"CountRepoIssues reads issue",   // a helper building the session
		"CreateIssue writes comment",    // variadic bean wrapper
		"CreateIssue writes issue",
		"DeleteLabel writes label",   // bean parameter wrapper
		"FindComments reads comment", // type parameter wrapper
		"GetIssueByID reads issue",
		"GetRepo reads repository",
		"GetSource reads login_source", // TableName method
		"GetUser reads users",
		"LabelIDs reads label", // table name passed as a string
		"ListBooks reads library_books",
		"ListIssues reads issue",        // named list type
		"MaxIssueID reads issue",        // SQL(…) in a chain
		"MigrateAddPinned writes issue", // a local copy of an existing table; not the local row type
		"RenameUsers writes users",      // gorm Model(…)
		"Stats reads issue",             // Table("`issue` i"), not the local row type
		"Totals reads order_totals",     // gorm Table("…")
		"UpdateIssueTitle writes issue",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\n\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
