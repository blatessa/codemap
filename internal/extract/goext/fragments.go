package goext

import (
	"go/ast"
	"go/constant"
	"go/types"
	"strings"

	"github.com/blatessa/codemap/internal/extract/sqlext"
	"github.com/blatessa/codemap/internal/graph"
)

// SQL assembled from fragments: query builders that put a statement together
// with +, fmt.Sprintf, a strings.Builder or a slice of clauses never pass a
// constant to a DB method, so sqlCall sees nothing. Every constant string in a
// function body is read as a possible piece of SQL instead
// (sqlext.ClassifyFragment), and the tables it names become reads/writes edges
// of the function.
//
// Complete statements written as SQL are trusted on their own, except for
// queries of the database's catalogs (pg_class, sqlite_master). A table named
// only by a fragment ("FROM entries e", " LEFT JOIN feeds f ON …") is kept
// only if the graph knows it from elsewhere (migrations, DDL in Go, ORM models,
// complete queries), which is checked once the whole repo has been read.

type sqlKey struct{ fn, query string }

// sqlFragment is a table access found in a constant string.
type sqlFragment struct {
	from, detail, file string
	line               int
	acc                sqlext.Access
	statement          bool
}

// scanFragments collects table accesses from the constant strings of every
// function body, skipping strings already classified as DB method arguments.
func (l *load) scanFragments() {
	l.eachFunc(func(c *fnCtx, body ast.Node) {
		if !l.x.b.has(c.id) {
			return
		}
		info := c.p.TypesInfo
		skip := map[ast.Expr]bool{}
		seen := map[string]bool{}
		ast.Inspect(body, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if messageCall(staticCallee(info, call)) {
					for _, a := range call.Args {
						skip[a] = true
					}
				}
				return true
			}
			e, ok := n.(ast.Expr)
			if !ok {
				return true
			}
			tv, ok := info.Types[e]
			if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
				return true
			}
			// The outermost constant: "SELECT … " + "FROM entries" is one string.
			s := constant.StringVal(tv.Value)
			if skip[e] || seen[s] || l.sqlSeen[sqlKey{c.id, s}] {
				return false
			}
			seen[s] = true
			f := sqlext.ClassifyFragment(s)
			if len(f.Accesses) == 0 {
				return false
			}
			file, line := l.pos(e.Pos())
			detail := sqlext.Collapse(s)
			for _, a := range f.Accesses {
				l.x.fragments = append(l.x.fragments, sqlFragment{c.id, detail, file, line, a, f.Statement})
			}
			return false
		})
	})
}

// messageCall reports whether f builds an error or writes a log line, whose
// string arguments are messages rather than SQL.
func messageCall(f *types.Func) bool {
	if f == nil || f.Pkg() == nil {
		return false
	}
	switch f.Pkg().Path() {
	case "errors", "log", "log/slog":
		return true
	case "fmt":
		return f.Name() == "Errorf" || strings.HasPrefix(f.Name(), "Print") || strings.HasPrefix(f.Name(), "Fprint")
	}
	return false
}

// addFragments adds the edges of the accesses scanFragments found: those from
// complete statements first (adding their tables), then those whose table the
// graph now knows.
func (x *extractor) addFragments() {
	for _, pass := range []bool{true, false} {
		for _, f := range x.fragments {
			if f.statement != pass {
				continue
			}
			id := sqlext.TableID(f.acc.Table)
			if sqlext.SystemTable(f.acc.Table) {
				continue
			}
			if f.statement && !x.b.has(id) {
				x.ensureTable(id, f.acc.Table)
			} else if n := x.b.nodes[id]; n == nil || n.Kind != graph.KindTable {
				continue
			}
			typ := graph.Reads
			if f.acc.Write {
				typ = graph.Writes
			}
			x.b.addEdge(graph.Edge{From: f.from, To: id, Type: typ, Detail: f.detail, File: f.file, Line: f.line})
		}
	}
}
