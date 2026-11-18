// Package sqlext classifies SQL query strings and builds a table schema from
// migration files. It uses a small tokenizer rather than a full
// parser: it understands enough of the statement shapes that matter for an
// architecture map (which tables a query reads or writes, which columns a table
// has) and ignores everything else.
package sqlext

import "strings"

type tokKind int

const (
	tWord   tokKind = iota // keyword or unquoted identifier
	tIdent                 // quoted identifier ("x", `x`, [x])
	tString                // string literal ('x', $$x$$)
	tNumber
	tParam // $1, ?, :name, @name
	tPunct
)

type token struct {
	kind tokKind
	text string // as written; for quoted identifiers, without the quotes
}

// up returns the upper-cased text of a word token, or "" for other kinds.
func (t token) up() string {
	if t.kind != tWord {
		return ""
	}
	return strings.ToUpper(t.text)
}

// name returns an identifier's name the way Postgres folds it: unquoted words
// are lower-cased, quoted identifiers are kept as written.
func (t token) name() string {
	if t.kind == tWord {
		return strings.ToLower(t.text)
	}
	return t.text
}

func (t token) isIdent() bool { return t.kind == tWord || t.kind == tIdent }

func (t token) is(p string) bool { return t.kind == tPunct && t.text == p }

// tokenize splits SQL into tokens, dropping whitespace and comments.
func tokenize(s string) []token {
	var toks []token
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f':
			i++
		case c == '-' && i+1 < len(s) && s[i+1] == '-':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(s) && s[i+1] == '*':
			end := strings.Index(s[i+2:], "*/")
			if end < 0 {
				i = len(s)
			} else {
				i += end + 4
			}
		case c == '\'':
			j := i + 1
			for j < len(s) {
				if s[j] == '\\' && j+1 < len(s) {
					j += 2
					continue
				}
				if s[j] == '\'' {
					if j+1 < len(s) && s[j+1] == '\'' {
						j += 2
						continue
					}
					break
				}
				j++
			}
			toks = append(toks, token{tString, s[i+1 : min(j, len(s))]})
			i = j + 1
		case c == '"' || c == '`':
			j := strings.IndexByte(s[i+1:], c)
			if j < 0 {
				j = len(s) - i - 1
			}
			toks = append(toks, token{tIdent, s[i+1 : i+1+j]})
			i += j + 2
		case c == '$':
			// $1, or dollar-quoted $tag$...$tag$
			j := i + 1
			for j < len(s) && (isWordByte(s[j])) {
				j++
			}
			if j > i+1 && allDigits(s[i+1:j]) {
				toks = append(toks, token{tParam, s[i:j]})
				i = j
				continue
			}
			if j < len(s) && s[j] == '$' {
				tag := s[i : j+1]
				end := strings.Index(s[j+1:], tag)
				if end < 0 {
					toks = append(toks, token{tString, s[j+1:]})
					i = len(s)
				} else {
					toks = append(toks, token{tString, s[j+1 : j+1+end]})
					i = j + 1 + end + len(tag)
				}
				continue
			}
			toks = append(toks, token{tPunct, "$"})
			i++
		case c == '?':
			toks = append(toks, token{tParam, "?"})
			i++
		case (c == ':' || c == '@') && i+1 < len(s) && isWordStart(s[i+1]) && !(c == ':' && i > 0 && s[i-1] == ':'):
			j := i + 1
			for j < len(s) && isWordByte(s[j]) {
				j++
			}
			toks = append(toks, token{tParam, s[i:j]})
			i = j
		case c == ':' && i+1 < len(s) && s[i+1] == ':':
			toks = append(toks, token{tPunct, "::"})
			i += 2
		case c >= '0' && c <= '9':
			j := i
			for j < len(s) && (s[j] >= '0' && s[j] <= '9' || s[j] == '.') {
				j++
			}
			toks = append(toks, token{tNumber, s[i:j]})
			i = j
		case isWordStart(c):
			j := i
			for j < len(s) && isWordByte(s[j]) {
				j++
			}
			toks = append(toks, token{tWord, s[i:j]})
			i = j
		case c >= 0x80:
			// Non-ASCII letters in identifiers.
			j := i
			for j < len(s) && (s[j] >= 0x80 || isWordByte(s[j])) {
				j++
			}
			toks = append(toks, token{tWord, s[i:j]})
			i = j
		default:
			toks = append(toks, token{tPunct, string(c)})
			i++
		}
	}
	return toks
}

func isWordStart(c byte) bool { return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

func isWordByte(c byte) bool { return isWordStart(c) || c >= '0' && c <= '9' }

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

// splitStatements splits tokens at top-level semicolons.
func splitStatements(toks []token) [][]token {
	var out [][]token
	start := 0
	for i, t := range toks {
		if t.is(";") {
			if i > start {
				out = append(out, toks[start:i])
			}
			start = i + 1
		}
	}
	if start < len(toks) {
		out = append(out, toks[start:])
	}
	return out
}

// splitTopLevel splits tokens at commas outside parentheses.
func splitTopLevel(toks []token) [][]token {
	var out [][]token
	depth, start := 0, 0
	for i, t := range toks {
		switch {
		case t.is("("):
			depth++
		case t.is(")"):
			depth--
		case t.is(",") && depth == 0:
			out = append(out, toks[start:i])
			start = i + 1
		}
	}
	if start < len(toks) {
		out = append(out, toks[start:])
	}
	return out
}

// matchParen returns the index of the ")" matching the "(" at i, or len(toks).
func matchParen(toks []token, i int) int {
	depth := 0
	for j := i; j < len(toks); j++ {
		switch {
		case toks[j].is("("):
			depth++
		case toks[j].is(")"):
			depth--
			if depth == 0 {
				return j
			}
		}
	}
	return len(toks)
}
