package sqlext

import (
	"strings"

	"github.com/blatessa/codemap/internal/graph"
)

// Access is one table a query touches.
type Access struct {
	Table string // as named in the query, lower-cased unless quoted; "schema.name" if qualified
	Write bool   // true for INSERT/UPDATE/DELETE/MERGE targets, false for FROM/JOIN/USING sources
}

// TableID returns the graph ID for a table name from Access.Table or Table.Name.
func TableID(name string) string {
	if schema, n, ok := strings.Cut(name, "."); ok {
		return graph.TableID(schema, n)
	}
	return graph.TableID("", name)
}

// statement keywords a query must start with to be classified.
var dmlStart = map[string]bool{
	"SELECT": true, "WITH": true, "INSERT": true, "UPDATE": true, "DELETE": true,
	"MERGE": true, "REPLACE": true, "UPSERT": true,
}

// keywords that, directly before "(", mean the parentheses hold a subquery or a
// list rather than a function call's arguments.
var nonFuncBeforeParen = map[string]bool{
	"IN": true, "EXISTS": true, "ANY": true, "ALL": true, "SOME": true, "AS": true,
	"FROM": true, "JOIN": true, "VALUES": true, "ON": true, "WHERE": true, "AND": true,
	"OR": true, "NOT": true, "SELECT": true, "LATERAL": true, "USING": true, "WITH": true,
	"UNION": true, "INTERSECT": true, "EXCEPT": true, "RETURNING": true, "SET": true,
	"THEN": true, "ELSE": true, "WHEN": true, "CASE": true, "BY": true, "MATERIALIZED": true,
	"HAVING": true, "IS": true, "LIKE": true, "ILIKE": true, "BETWEEN": true, "DISTINCT": true,
}

// keywords that end a table reference's optional alias.
var clauseWords = map[string]bool{
	"WHERE": true, "JOIN": true, "INNER": true, "LEFT": true, "RIGHT": true, "FULL": true,
	"CROSS": true, "NATURAL": true, "ON": true, "USING": true, "GROUP": true, "ORDER": true,
	"LIMIT": true, "OFFSET": true, "HAVING": true, "WINDOW": true, "UNION": true,
	"INTERSECT": true, "EXCEPT": true, "SET": true, "VALUES": true, "RETURNING": true,
	"FOR": true, "SELECT": true, "DEFAULT": true, "OVERRIDING": true,
	"OUTER": true, "LATERAL": true, "FETCH": true, "AS": true, "WHEN": true, "OUTPUT": true,
}

// Classify returns the tables a query reads and writes. It returns nil if the
// query doesn't start with SELECT, WITH, INSERT, UPDATE, DELETE, MERGE, REPLACE or
// UPSERT, so arbitrary constant strings passed to methods named like DB methods
// (cache.Get("key")) produce nothing.
//
// Targets of INSERT INTO, UPDATE, DELETE FROM and MERGE INTO are writes; tables
// after FROM, JOIN and USING are reads. CTE names are not tables.
func Classify(query string) []Access {
	toks := tokenize(query)
	if len(toks) == 0 || !dmlStart[toks[0].up()] {
		return nil
	}
	ctes := map[string]bool{}
	for i := 0; i+2 < len(toks); i++ {
		if toks[i].isIdent() && toks[i+1].up() == "AS" && (toks[i+2].is("(") || toks[i+2].up() == "NOT" || toks[i+2].up() == "MATERIALIZED") {
			if i > 0 && (toks[i-1].up() == "WITH" || toks[i-1].up() == "RECURSIVE" || toks[i-1].is(",")) {
				ctes[toks[i].name()] = true
			}
		}
	}

	var out []Access
	seen := map[Access]bool{}
	add := func(name string, write bool) {
		if name == "" || ctes[name] {
			return
		}
		a := Access{name, write}
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}

	var stack []bool // true = function-call parentheses
	inFunc := func() bool { return len(stack) > 0 && stack[len(stack)-1] }
	prevUp := func(i int) string {
		if i > 0 {
			return toks[i-1].up()
		}
		return ""
	}
	sawDelete, sawMerge := false, false
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.is("(") {
			fn := i > 0 && toks[i-1].isIdent() && !nonFuncBeforeParen[toks[i-1].up()]
			stack = append(stack, fn)
			continue
		}
		if t.is(")") {
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			continue
		}
		if inFunc() {
			continue // EXTRACT(x FROM y), SUBSTRING(s FROM 1), TRIM(BOTH FROM s)
		}
		switch t.up() {
		case "INSERT", "REPLACE":
			// MySQL allows INSERT [IGNORE] tbl SET … without INTO.
			j := i + 1
			if j < len(toks) && (toks[j].up() == "IGNORE" || toks[j].up() == "LOW_PRIORITY" || toks[j].up() == "DELAYED" || toks[j].up() == "HIGH_PRIORITY") {
				j++
			}
			if j < len(toks) && toks[j].isIdent() && toks[j].up() != "INTO" && toks[j].up() != "OR" {
				name, k := tableRef(toks, j, true)
				add(name, true)
				i = k - 1
			}
		case "DELETE":
			sawDelete = true
		case "MERGE":
			sawMerge = true
		case "FROM":
			if p := prevUp(i); p == "DISTINCT" {
				continue
			}
			write := prevUp(i) == "DELETE"
			i = tableList(toks, i+1, func(name string, first bool) { add(name, write && first) })
		case "JOIN":
			i = tableList(toks, i+1, func(name string, first bool) {
				if first {
					add(name, false)
				}
			})
		case "INTO":
			switch prevUp(i) {
			case "INSERT", "REPLACE", "MERGE", "IGNORE", "UPSERT":
				name, j := tableRef(toks, i+1, true)
				add(name, true)
				i = j - 1
			}
		case "UPDATE":
			switch prevUp(i) {
			case "FOR", "DO", "KEY", "ON", "NO":
				continue
			}
			name, j := tableRef(toks, i+1, false)
			add(name, true)
			i = j - 1
		case "USING":
			if sawDelete || sawMerge {
				i = tableList(toks, i+1, func(name string, _ bool) { add(name, false) })
			}
		}
	}
	return out
}

// tableRef reads a table name at i (skipping ONLY), returning the name and the
// index after it. It returns "" for subqueries and, unless columns is set (INSERT
// INTO t (cols)), for function calls like generate_series(...).
func tableRef(toks []token, i int, columns bool) (string, int) {
	for i < len(toks) && (toks[i].up() == "ONLY" || toks[i].up() == "LATERAL" || toks[i].up() == "TABLE") {
		i++
	}
	if i >= len(toks) || !toks[i].isIdent() {
		return "", i
	}
	if toks[i].kind == tWord && (dmlStart[toks[i].up()] || clauseWords[toks[i].up()]) {
		return "", i
	}
	name := toks[i].name()
	i++
	for i+1 < len(toks) && toks[i].is(".") && toks[i+1].isIdent() {
		name += "." + toks[i+1].name()
		i += 2
	}
	if i < len(toks) && toks[i].is("(") && !columns {
		return "", i
	}
	if s, n, ok := strings.Cut(name, "."); ok && s == "public" {
		name = n
	}
	return name, i
}

// tableList reads a comma-separated FROM list starting at i, calling fn for each
// table, and returns the index of the last token consumed.
func tableList(toks []token, i int, fn func(name string, first bool)) int {
	first := true
	for {
		name, j := tableRef(toks, i, false)
		if name != "" {
			fn(name, first)
		}
		first = false
		// skip [AS] alias
		if j < len(toks) && toks[j].up() == "AS" {
			j++
		}
		if j < len(toks) && toks[j].isIdent() && !clauseWords[toks[j].up()] && !dmlStart[toks[j].up()] {
			j++
		}
		if j < len(toks) && toks[j].is(",") && name != "" {
			i = j + 1
			continue
		}
		return j - 1
	}
}

// Collapse returns query on one line: line comments dropped and runs of
// whitespace replaced by single spaces.
func Collapse(query string) string {
	var b strings.Builder
	for line := range strings.SplitSeq(query, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return strings.Join(strings.Fields(b.String()), " ")
}
