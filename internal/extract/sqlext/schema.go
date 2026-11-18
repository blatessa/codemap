package sqlext

import (
	"regexp"
	"slices"
	"sort"
	"strings"
)

// Column is one column of a table. Note is "pk", "unique", "→ table.col",
// "index" or "".
type Column struct {
	Name, Type, Note string
}

// Table is a table in the schema built from migrations.
type Table struct {
	Name    string // "orders", or "schema.name" outside the public schema
	Columns []Column
	Sources []string // migration files that created or changed it, in apply order
}

// Schema is the current database schema, built by applying migrations in order.
type Schema struct {
	tables map[string]*Table
}

// NewSchema returns an empty schema.
func NewSchema() *Schema { return &Schema{tables: map[string]*Table{}} }

// Tables returns the tables sorted by name.
func (s *Schema) Tables() []*Table {
	out := make([]*Table, 0, len(s.tables))
	for _, t := range s.tables {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Table returns a table by name, or nil.
func (s *Schema) Table(name string) *Table { return s.tables[name] }

var downMarker = regexp.MustCompile(`(?im)^\s*--\s*(\+goose\s+down|\+migrate\s+down|migrate:down)\b`)

// UpSection returns the part of a migration file that applies it: goose
// (-- +goose Down), sql-migrate (-- +migrate Down) and dbmate (-- migrate:down)
// files have their down section cut off.
func UpSection(sql string) string {
	if loc := downMarker.FindStringIndex(sql); loc != nil {
		return sql[:loc[0]]
	}
	return sql
}

// Apply applies one migration file's statements. file is recorded in the
// Sources of every table it touches. Down sections are skipped (see UpSection).
// Statements other than CREATE TABLE, CREATE INDEX, ALTER TABLE, DROP TABLE and
// RENAME TABLE are ignored.
func (s *Schema) Apply(file, sql string) {
	for _, st := range splitStatements(tokenize(UpSection(sql))) {
		s.applyStatement(file, st)
	}
}

func (s *Schema) touch(t *Table, file string) {
	if file != "" && !slices.Contains(t.Sources, file) {
		t.Sources = append(t.Sources, file)
	}
}

// qualifiedName reads a possibly schema-qualified name at i.
func qualifiedName(toks []token, i int) (string, int) {
	if i >= len(toks) || !toks[i].isIdent() {
		return "", i
	}
	name := toks[i].name()
	i++
	for i+1 < len(toks) && toks[i].is(".") && toks[i+1].isIdent() {
		name += "." + toks[i+1].name()
		i += 2
	}
	if sc, n, ok := strings.Cut(name, "."); ok && sc == "public" {
		name = n
	}
	return name, i
}

// skipWords skips any of the given upper-case words at i.
func skipWords(toks []token, i int, words ...string) int {
	for i < len(toks) && slices.Contains(words, toks[i].up()) {
		i++
	}
	return i
}

func (s *Schema) applyStatement(file string, st []token) {
	if len(st) < 2 {
		return
	}
	switch st[0].up() {
	case "CREATE":
		i := skipWords(st, 1, "OR", "REPLACE", "GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "UNLOGGED", "UNIQUE", "FULLTEXT", "SPATIAL")
		if i < len(st) && st[i].up() == "TABLE" {
			s.createTable(file, st, i+1)
		} else if i < len(st) && st[i].up() == "INDEX" {
			s.createIndex(file, st, i+1, st[1].up() == "UNIQUE")
		}
	case "ALTER":
		if st[1].up() == "TABLE" {
			s.alterTable(file, st, 2)
		}
	case "DROP":
		if st[1].up() == "TABLE" {
			i := skipWords(st, 2, "IF", "EXISTS")
			for _, part := range splitTopLevel(st[i:]) {
				if name, _ := qualifiedName(part, 0); name != "" {
					delete(s.tables, name)
				}
			}
		}
	case "RENAME":
		// MySQL: RENAME TABLE a TO b
		if st[1].up() == "TABLE" {
			from, i := qualifiedName(st, 2)
			if i < len(st) && st[i].up() == "TO" {
				to, _ := qualifiedName(st, i+1)
				s.renameTable(file, from, to)
			}
		}
	}
}

func (s *Schema) renameTable(file, from, to string) {
	t := s.tables[from]
	if t == nil || to == "" {
		return
	}
	delete(s.tables, from)
	t.Name = to
	s.tables[to] = t
	s.touch(t, file)
}

func (s *Schema) createTable(file string, st []token, i int) {
	ifNotExists := false
	if i+2 < len(st) && st[i].up() == "IF" && st[i+1].up() == "NOT" && st[i+2].up() == "EXISTS" {
		ifNotExists = true
		i += 3
	}
	name, i := qualifiedName(st, i)
	if name == "" {
		return
	}
	if ifNotExists && s.tables[name] != nil {
		return
	}
	t := &Table{Name: name}
	s.tables[name] = t
	s.touch(t, file)
	if i >= len(st) || !st[i].is("(") {
		return // CREATE TABLE x AS SELECT …, PARTITION OF …
	}
	end := matchParen(st, i)
	for _, def := range splitTopLevel(st[i+1 : end]) {
		s.tableElement(t, def, false)
	}
}

func (s *Schema) col(t *Table, name string) *Column {
	for i := range t.Columns {
		if t.Columns[i].Name == name {
			return &t.Columns[i]
		}
	}
	return nil
}

func notePrio(n string) int {
	switch {
	case n == "pk":
		return 4
	case strings.HasPrefix(n, "→"):
		return 3
	case n == "unique":
		return 2
	case n == "index":
		return 1
	}
	return 0
}

func setNote(c *Column, note string) {
	if c != nil && notePrio(note) > notePrio(c.Note) {
		c.Note = note
	}
}

// columnConstraintStart lists words that end a column's type.
var columnConstraintStart = map[string]bool{
	"NOT": true, "NULL": true, "DEFAULT": true, "PRIMARY": true, "UNIQUE": true,
	"REFERENCES": true, "CHECK": true, "CONSTRAINT": true, "GENERATED": true, "COLLATE": true,
	"AUTO_INCREMENT": true, "AUTOINCREMENT": true, "COMMENT": true, "IDENTITY": true,
	"ON": true, "AS": true, "FIRST": true, "AFTER": true,
}

// tableElement applies one element of a CREATE TABLE list or an ALTER TABLE ADD:
// a column definition or a table constraint.
func (s *Schema) tableElement(t *Table, def []token, alterAdd bool) {
	if len(def) == 0 {
		return
	}
	i := 0
	if def[0].up() == "CONSTRAINT" {
		i = 2
	}
	if i >= len(def) {
		return
	}
	switch def[i].up() {
	case "PRIMARY":
		for _, c := range parenNames(def, i) {
			setNote(s.col(t, c), "pk")
		}
		return
	case "UNIQUE":
		cols := parenNames(def, i)
		note := "unique"
		if len(cols) > 1 {
			note = "index"
		}
		for _, c := range cols {
			setNote(s.col(t, c), note)
		}
		return
	case "FOREIGN":
		cols := parenNames(def, i)
		ref := referencesNote(s, def, i)
		if len(cols) == 1 && ref != "" {
			setNote(s.col(t, cols[0]), ref)
		}
		return
	case "KEY", "INDEX", "FULLTEXT", "SPATIAL":
		// MySQL's KEY name (cols); without a column list it's a column
		// named key: "key TEXT PRIMARY KEY", "key varchar(64)".
		if cols := parenNames(def, i); len(cols) > 0 {
			for _, c := range cols {
				setNote(s.col(t, c), "index")
			}
			return
		}
	case "CHECK", "EXCLUDE", "LIKE", "PERIOD":
		return
	}
	if i != 0 || !def[0].isIdent() {
		return
	}
	// Column definition: name type [constraints]
	c := Column{Name: def[0].name()}
	j := 1
	for j < len(def) && !columnConstraintStart[def[j].up()] {
		if def[j].is("(") {
			k := matchParen(def, j)
			j = k + 1
			continue
		}
		j++
	}
	c.Type = renderType(def[1:j])
	rest := def[j:]
	for k := 0; k < len(rest); k++ {
		switch rest[k].up() {
		case "PRIMARY":
			setNote(&c, "pk")
		case "UNIQUE":
			setNote(&c, "unique")
		case "REFERENCES":
			if n := referencesNote(s, rest, k); n != "" {
				setNote(&c, n)
			}
		}
	}
	if existing := s.col(t, c.Name); existing != nil {
		if alterAdd {
			return // ADD COLUMN IF NOT EXISTS on an existing column
		}
		*existing = c
		return
	}
	t.Columns = append(t.Columns, c)
}

// parenNames returns the identifiers in the first parenthesised list at or after i.
func parenNames(toks []token, i int) []string {
	for i < len(toks) && !toks[i].is("(") {
		i++
	}
	if i >= len(toks) {
		return nil
	}
	end := matchParen(toks, i)
	var out []string
	for _, part := range splitTopLevel(toks[i+1 : end]) {
		if len(part) > 0 && part[0].isIdent() && (len(part) == 1 || !part[1].is("(")) {
			out = append(out, part[0].name())
		}
	}
	return out
}

// referencesNote builds "→ table.col" from a REFERENCES clause at or after i. If
// no column is named, the referenced table's primary key is used.
func referencesNote(s *Schema, toks []token, i int) string {
	for i < len(toks) && toks[i].up() != "REFERENCES" {
		i++
	}
	if i >= len(toks) {
		return ""
	}
	table, j := qualifiedName(toks, i+1)
	if table == "" {
		return ""
	}
	col := ""
	if j < len(toks) && toks[j].is("(") {
		if cols := parenNames(toks, j); len(cols) > 0 {
			col = cols[0]
		}
	}
	if col == "" {
		if t := s.tables[table]; t != nil {
			for _, c := range t.Columns {
				if c.Note == "pk" {
					col = c.Name
					break
				}
			}
		}
	}
	if col == "" {
		return "→ " + table
	}
	return "→ " + table + "." + col
}

// renderType writes a column type compactly: "varchar(255)", "numeric(10, 2)",
// "timestamp with time zone", "text[]".
func renderType(toks []token) string {
	var b strings.Builder
	for i, t := range toks {
		txt := t.text
		if t.kind == tWord {
			txt = strings.ToLower(txt)
		}
		if i > 0 {
			prev := toks[i-1]
			needSpace := (t.kind != tPunct && !(prev.kind == tPunct && prev.text != ",")) || (prev.is(",") && t.kind != tPunct)
			if needSpace {
				b.WriteByte(' ')
			}
		}
		b.WriteString(txt)
	}
	return b.String()
}

func (s *Schema) createIndex(file string, st []token, i int, unique bool) {
	i = skipWords(st, i, "CONCURRENTLY")
	if i+2 < len(st) && st[i].up() == "IF" && st[i+1].up() == "NOT" && st[i+2].up() == "EXISTS" {
		i += 3
	}
	// optional index name, then ON
	for i < len(st) && st[i].up() != "ON" {
		i++
	}
	i = skipWords(st, i+1, "ONLY")
	name, i := qualifiedName(st, i)
	t := s.tables[name]
	if t == nil {
		return
	}
	s.touch(t, file)
	cols := parenNames(st, i)
	note := "index"
	if unique && len(cols) == 1 {
		note = "unique"
	}
	for _, c := range cols {
		setNote(s.col(t, c), note)
	}
}

func (s *Schema) alterTable(file string, st []token, i int) {
	i = skipWords(st, i, "IF", "EXISTS", "ONLY")
	name, i := qualifiedName(st, i)
	t := s.tables[name]
	if t == nil {
		return
	}
	s.touch(t, file)
	for _, act := range splitTopLevel(st[i:]) {
		if len(act) == 0 {
			continue
		}
		switch act[0].up() {
		case "ADD":
			j := skipWords(act, 1, "COLUMN")
			if j+2 < len(act) && act[j].up() == "IF" && act[j+1].up() == "NOT" && act[j+2].up() == "EXISTS" {
				j += 3
			}
			s.tableElement(t, act[j:], true)
		case "DROP":
			if len(act) > 1 && (act[1].up() == "CONSTRAINT" || act[1].up() == "INDEX" || act[1].up() == "KEY" || act[1].up() == "PRIMARY" || act[1].up() == "FOREIGN") {
				continue
			}
			j := skipWords(act, 1, "COLUMN", "IF", "EXISTS")
			if j < len(act) && act[j].isIdent() {
				col := act[j].name()
				t.Columns = slices.DeleteFunc(t.Columns, func(c Column) bool { return c.Name == col })
			}
		case "RENAME":
			if len(act) >= 3 && act[1].up() == "TO" {
				to, _ := qualifiedName(act, 2)
				s.renameTable("", name, to)
				t = s.tables[to]
				name = to
				continue
			}
			if len(act) > 1 && act[1].up() == "CONSTRAINT" {
				continue
			}
			j := skipWords(act, 1, "COLUMN")
			if j+2 < len(act) && act[j+1].up() == "TO" {
				if c := s.col(t, act[j].name()); c != nil {
					c.Name = act[j+2].name()
				}
			}
		case "ALTER":
			j := skipWords(act, 1, "COLUMN")
			if j >= len(act) {
				continue
			}
			c := s.col(t, act[j].name())
			k := skipWords(act, j+1, "SET", "DATA")
			if c != nil && k < len(act) && act[k].up() == "TYPE" {
				end := k + 1
				for end < len(act) && act[end].up() != "USING" && act[end].up() != "COLLATE" {
					end++
				}
				c.Type = renderType(act[k+1 : end])
			}
		case "MODIFY":
			// MySQL: MODIFY [COLUMN] coldef
			j := skipWords(act, 1, "COLUMN")
			s.tableElement(t, act[j:], false)
		case "CHANGE":
			// MySQL: CHANGE [COLUMN] old coldef
			j := skipWords(act, 1, "COLUMN")
			if j+1 < len(act) {
				old := act[j].name()
				newDef := act[j+1:]
				if c := s.col(t, old); c != nil && len(newDef) > 0 {
					c.Name = newDef[0].name()
					s.tableElement(t, newDef, false)
				}
			}
		}
	}
}
