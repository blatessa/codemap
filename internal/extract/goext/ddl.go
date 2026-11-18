package goext

import (
	"go/ast"
	"go/constant"
	"regexp"
	"sort"
	"strings"

	"github.com/blatessa/codemap/internal/extract/sqlext"
)

// Schema DDL kept in Go strings: repos that create their tables from the
// program (an embedded list of migrations, a schema constant run at startup)
// have no .sql files, so their CREATE TABLE and ALTER TABLE statements are
// read from the constant strings in the Go code.

var ddlStart = regexp.MustCompile(`(?i)\b(create|alter)\s+(\w+\s+)*?table\b`)

type ddlString struct {
	file string
	off  int
	sql  string
}

// addGoDDL applies the constant strings holding table DDL to the repo's Go
// schema, in file then position order, and gives each table it defines its
// columns. It runs before calls are scanned so ORM models and queries find
// these tables by name.
//
// Tables a migration defines are left alone: migrations are the schema's
// history, while DDL in Go is often a bootstrap or test copy (SQLite for local
// runs) that lags behind or differs by dialect. Merging the two would mix
// dialects' types in one table.
func (l *load) addGoDDL() {
	var found []ddlString
	for _, p := range l.plain {
		for _, f := range p.Syntax {
			rel, _ := l.pos(f.Pos())
			if rel == "" || l.fileExcluded(rel) {
				continue
			}
			ast.Inspect(f, func(n ast.Node) bool {
				e, ok := n.(ast.Expr)
				if !ok {
					return true
				}
				switch e.(type) {
				case *ast.Ident, *ast.SelectorExpr:
					// A use of a named constant: its declaration is read instead.
					return false
				}
				tv, ok := p.TypesInfo.Types[e]
				if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
					return true
				}
				// The outermost constant: "CREATE TABLE a (…);" + "CREATE TABLE b (…);" is one string.
				if s := constant.StringVal(tv.Value); ddlStart.MatchString(s) {
					found = append(found, ddlString{rel, l.fset.Position(e.Pos()).Offset, s})
				}
				return false
			})
		}
	}
	if len(found) == 0 {
		return
	}
	sort.SliceStable(found, func(i, j int) bool {
		if found[i].file != found[j].file {
			return found[i].file < found[j].file
		}
		return found[i].off < found[j].off
	})
	if l.x.ddl == nil {
		l.x.ddl = sqlext.NewSchema()
	}
	for _, d := range found {
		l.x.ddl.Apply(d.file, d.sql)
	}
	for _, t := range l.x.ddl.Tables() {
		id := sqlext.TableID(t.Name)
		// A format string's placeholder (ALTER TABLE `%s` …) isn't a table.
		if l.x.migTables[id] || strings.Contains(t.Name, "%") {
			continue
		}
		l.ensureTable(id, t.Name)
		l.x.b.nodes[id].Fields = t.Fields()
	}
}
