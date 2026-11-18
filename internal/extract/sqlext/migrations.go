package sqlext

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// DatabaseModule is the module every table node belongs to.
const DatabaseModule = "mod:sql:database"

// DefaultMigrations are the globs used when config.migrations is empty.
var DefaultMigrations = []string{"db/migrations/*.sql", "migrations/*.sql", "**/migrations/*.sql"}

// SkippedDirs are directory names never walked, on top of config.exclude: they
// hold vendored or foreign code, fixtures, or tooling state. Directories whose
// names start with "." or "_" are skipped too, as the go command does.
var SkippedDirs = map[string]bool{"vendor": true, "node_modules": true, "testdata": true, "third_party": true}

// SkipDir reports whether the directory rel (slash-separated, relative to the
// repo root) should not be walked.
func SkipDir(rel string, exclude []string) bool {
	if rel == "." || rel == "" {
		return false
	}
	base := path.Base(rel)
	if SkippedDirs[base] || strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_") {
		return true
	}
	return Excluded(rel, exclude) || Excluded(rel+"/", exclude)
}

// Excluded reports whether rel matches any of the globs.
func Excluded(rel string, globs []string) bool {
	for _, g := range globs {
		if MatchGlob(g, rel) {
			return true
		}
	}
	return false
}

// MatchGlob matches a slash-separated path against a glob where "**" matches
// any number of path segments (including none) and other segments use
// path.Match syntax. A pattern ending in "/**" also matches the directory itself.
func MatchGlob(pattern, name string) bool {
	name = strings.TrimSuffix(name, "/")
	return matchSegs(strings.Split(pattern, "/"), strings.Split(name, "/"))
}

func matchSegs(pat, segs []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			if len(pat) == 1 {
				return true
			}
			for i := 0; i <= len(segs); i++ {
				if matchSegs(pat[1:], segs[i:]) {
					return true
				}
			}
			return false
		}
		if len(segs) == 0 {
			return false
		}
		if ok, _ := path.Match(pat[0], segs[0]); !ok {
			return false
		}
		pat, segs = pat[1:], segs[1:]
	}
	return len(segs) == 0
}

// MigrationFiles returns the migration files under root matching the configured
// (or default) globs, as sorted slash-separated relative paths. golang-migrate
// "*.down.sql" files are left out.
func MigrationFiles(root string, cfg project.Config) ([]string, error) {
	globs := cfg.Migrations
	if len(globs) == 0 {
		globs = DefaultMigrations
	}
	var files []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if SkipDir(rel, cfg.Exclude) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(rel, ".down.sql") || Excluded(rel, cfg.Exclude) {
			return nil
		}
		if Excluded(rel, globs) {
			files = append(files, rel)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

// BuildSchema applies the migration files (relative to root) in order.
func BuildSchema(root string, files []string) (*Schema, error) {
	s := NewSchema()
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(f)))
		if err != nil {
			return nil, err
		}
		s.Apply(f, string(data))
	}
	return s, nil
}

// Migrations builds table nodes from the repo's migrations: each table is
// kind "table", external, in module mod:sql:database, with fields.columns
// ([name, type, note] rows) and fields.source (the migration files that touched
// it). It returns an empty graph if there are no migrations.
func Migrations(root string, cfg project.Config) (*graph.Graph, error) {
	files, err := MigrationFiles(root, cfg)
	if err != nil {
		return nil, err
	}
	g := &graph.Graph{Version: graph.Version}
	if len(files) == 0 {
		return g, nil
	}
	s, err := BuildSchema(root, files)
	if err != nil {
		return nil, err
	}
	g.Modules = append(g.Modules, DatabaseModuleFor(files))
	for _, t := range s.Tables() {
		g.Nodes = append(g.Nodes, graph.Node{
			ID: TableID(t.Name), Kind: graph.KindTable, Label: t.Name, Module: DatabaseModule,
			External: true,
			Fields:   t.Fields(),
		})
	}
	return g, nil
}

// Fields are a table node's fields: columns ([name, type, note] rows) and
// source (the files that defined it, in apply order).
func (t *Table) Fields() map[string]any {
	cols := make([]any, 0, len(t.Columns))
	for _, c := range t.Columns {
		cols = append(cols, []any{c.Name, c.Type, c.Note})
	}
	src := make([]any, 0, len(t.Sources))
	for _, f := range t.Sources {
		src = append(src, f)
	}
	return map[string]any{"columns": cols, "source": src}
}

// DatabaseModuleFor returns the database module, with its path set to the
// directory holding the migrations when they all share one.
func DatabaseModuleFor(files []string) graph.Module {
	m := graph.Module{ID: DatabaseModule, Label: "database", Lang: "sql", External: true}
	for i, f := range files {
		d := path.Dir(f)
		if i == 0 {
			m.Path = d
		} else if m.Path != d {
			m.Path = ""
			break
		}
	}
	return m
}
