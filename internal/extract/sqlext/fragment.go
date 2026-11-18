package sqlext

import (
	"regexp"
	"strings"
)

// Fragment is the result of ClassifyFragment.
type Fragment struct {
	Accesses []Access
	// Statement is true when the string is a complete statement written as SQL
	// (it starts with an upper-case SELECT, INSERT, UPDATE, … keyword). Tables
	// named by such a string can be trusted on their own; tables named only by
	// a fragment ("FROM entries e", " LEFT JOIN feeds f ON …") should be checked
	// against tables known from elsewhere.
	Statement bool
}

// proseMarkers are substrings typical of error and log messages, which often
// mention "from" and "update" but never appear in SQL.
var proseMarkers = []string{
	"could not", "couldn't", "failed to", "unable to", "cannot ", "can't", "won't", "don't",
	"%w", "%v", "://", "error while", "please ",
}

var tableName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_$]*$`)

// ClassifyFragment returns the tables a piece of SQL reads and writes. Unlike
// Classify it accepts parts of statements as query builders assemble them:
// "FROM entries e LEFT JOIN feeds f ON f.id = e.feed_id", " WHERE id IN (SELECT
// id FROM t)", "UPDATE t SET". It is strict about what counts as SQL:
//
//   - strings that read like messages ("failed to read from cache") give nothing;
//   - a FROM, JOIN, INTO or UPDATE keyword counts only if it's written in upper
//     case or the string also has a SELECT or WHERE;
//   - the table must be followed by the end of the string, an alias, a clause
//     keyword, a comma or a parenthesis (UPDATE also needs SET).
//
// Complete statements starting with an upper-case keyword are classified with
// Classify; lower-case ones ("select a file from the list") get the fragment
// rules.
func ClassifyFragment(s string) Fragment {
	low := strings.ToLower(s)
	for _, m := range proseMarkers {
		if strings.Contains(low, m) {
			return Fragment{}
		}
	}
	if !strings.ContainsAny(strings.TrimSpace(s), " \t\n") {
		return Fragment{}
	}
	toks := tokenize(s)
	if len(toks) == 0 {
		return Fragment{}
	}
	if dmlStart[toks[0].up()] && toks[0].text == toks[0].up() {
		// The statement is trusted only if the stricter fragment rules see
		// the same tables ("UPDATE the status" has no SET).
		strict := map[Access]bool{}
		for _, a := range fragmentAccesses(toks) {
			strict[a] = true
		}
		var out []Access
		trusted := true
		for _, a := range Classify(s) {
			if validTable(a.Table) {
				out = append(out, a)
				trusted = trusted && strict[a]
			}
		}
		return Fragment{Accesses: out, Statement: trusted}
	}
	return Fragment{Accesses: fragmentAccesses(toks)}
}

// SystemTable reports whether name is a database's own catalog (pg_class,
// sqlite_master, information_schema.columns, sys.indexes): queries of these
// inspect the schema rather than the application's data.
func SystemTable(name string) bool {
	n := strings.ToLower(name)
	for _, p := range []string{"pg_", "sqlite_", "information_schema.", "sys.", "mysql.", "performance_schema."} {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return n == "dual"
}

func validTable(name string) bool {
	for p := range strings.SplitSeq(name, ".") {
		if !tableName.MatchString(p) {
			return false
		}
	}
	return true
}

func fragmentAccesses(toks []token) []Access {
	lowerOK := false // lower-case keywords count when the string has SELECT or WHERE
	ctes := map[string]bool{}
	for i, t := range toks {
		if u := t.up(); u == "SELECT" || u == "WHERE" {
			lowerOK = true
		}
		if i+2 < len(toks) && t.isIdent() && toks[i+1].up() == "AS" && toks[i+2].is("(") {
			ctes[t.name()] = true
		}
	}
	keyword := func(t token) bool { return t.kind == tWord && (lowerOK || t.text == t.up()) }

	var out []Access
	seen := map[Access]bool{}
	add := func(name string, write bool) {
		if name == "" || ctes[name] || !validTable(name) {
			return
		}
		a := Access{name, write}
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	prevUp := func(i int) string {
		if i > 0 {
			return toks[i-1].up()
		}
		return ""
	}
	var stack []bool // true = function-call parentheses
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.is("(") {
			stack = append(stack, i > 0 && toks[i-1].isIdent() && !nonFuncBeforeParen[toks[i-1].up()])
			continue
		}
		if t.is(")") {
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			continue
		}
		if len(stack) > 0 && stack[len(stack)-1] {
			continue // EXTRACT(x FROM y)
		}
		if !keyword(t) {
			continue
		}
		switch t.up() {
		case "INTO":
			switch prevUp(i) {
			case "INSERT", "REPLACE", "MERGE", "UPSERT", "IGNORE":
				if name, j := tableRef(toks, i+1, true); name != "" && fragmentEnd(toks, j, true) {
					add(name, true)
				}
			}
		case "UPDATE":
			switch prevUp(i) {
			case "FOR", "DO", "KEY", "ON", "NO":
				continue
			}
			name, j := tableRef(toks, i+1, false)
			j = skipAlias(toks, j)
			if name != "" && j < len(toks) && toks[j].up() == "SET" {
				add(name, true)
			}
		case "FROM", "JOIN":
			if t.up() == "FROM" && prevUp(i) == "DISTINCT" {
				continue
			}
			write := t.up() == "FROM" && prevUp(i) == "DELETE"
			for k := i + 1; ; {
				name, j := tableRef(toks, k, false)
				if name == "" {
					break
				}
				j = skipAlias(toks, j)
				if !fragmentEnd(toks, j, false) {
					break
				}
				add(name, write)
				write = false
				if t.up() == "JOIN" || j >= len(toks) || !toks[j].is(",") {
					break
				}
				k = j + 1
			}
		}
	}
	return out
}

// skipAlias skips "[AS] alias" at i.
func skipAlias(toks []token, i int) int {
	if i < len(toks) && toks[i].up() == "AS" {
		i++
	}
	if i < len(toks) && toks[i].kind == tWord && !clauseWords[toks[i].up()] && !dmlStart[toks[i].up()] {
		i++
	}
	return i
}

// fragmentEnd reports whether the token at i may follow a table reference: the
// end of the string, a clause keyword, a comma, a parenthesis, a semicolon or a
// fmt verb (" FROM entries e %s").
func fragmentEnd(toks []token, i int, insert bool) bool {
	if i >= len(toks) {
		return true
	}
	t := toks[i]
	switch {
	case t.is(",") || t.is(")") || t.is(";") || t.is("%"):
		return true
	case t.is("("):
		return insert
	case t.kind == tWord:
		u := t.up()
		return clauseWords[u] || u == "VALUES" || u == "SELECT" || u == "DEFAULT"
	}
	return false
}
