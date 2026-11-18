package goext

import (
	"bytes"
	"go/ast"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/blatessa/codemap/internal/extract/sqlext"
	"github.com/blatessa/codemap/internal/graph"
)

// Screens of server-rendered apps. Template files (templateExts) anywhere in
// the repo are named the way template loaders name them: by their path below
// each enclosing templates/views/… directory, with and without the extension
// ("repo/issue/list", "repo/issue/list.tmpl"), by their file name with the
// extension, and by the {{define "name"}} blocks they hold. Outside such a
// directory only files with {{actions}} count. A repo Go function passing one
// of those names as a constant string argument to a call (ctx.HTML(200,
// tplIssues), view.Render("entries"), render(w, "home")) renders that screen;
// see scanRenders for when a bare name counts. Names more than one file goes
// by are ignored. Only rendered templates, and the partials they include with
// {{template "name"}}, become nodes: screens, in their own external module,
// like tables.

// ScreensModule is the module every screen node belongs to.
const ScreensModule = "mod:tmpl:templates"

var templateExts = map[string]bool{".tmpl": true, ".gohtml": true, ".html": true, ".tpl": true}

// templateDirs are directory names template loaders conventionally use as a root.
var templateDirs = map[string]bool{"templates": true, "template": true, "views": true, "tmpl": true, "tpl": true}

// skippedTemplateDirs hold build output, never templates the server renders.
var skippedTemplateDirs = map[string]bool{"dist": true, "build": true}

var (
	defineRe   = regexp.MustCompile(`\{\{-?\s*(?:define|block)\s+"([^"]+)"`)
	templateRe = regexp.MustCompile(`\{\{-?\s*template\s+"([^"]+)"`)
)

type include struct {
	name string
	line int
}

type tmplFile struct {
	rel      string    // repo-relative path
	name     string    // screen name: path below the nearest template dir, no extension
	includes []include // {{template "x"}} uses
}

// templates are the repo's template files and the names they go by.
type templates struct {
	files    []*tmplFile
	byName   map[string]*tmplFile // unambiguous names only
	rendered map[*tmplFile]bool
}

func (t *templates) lookup(s string) *tmplFile {
	if t == nil || s == "" || strings.ContainsAny(s, " \t\n{}") {
		return nil
	}
	return t.byName[s]
}

// findTemplates walks the repo for template files.
func findTemplates(root string, exclude []string) *templates {
	t := &templates{byName: map[string]*tmplFile{}, rendered: map[*tmplFile]bool{}}
	names := map[string]map[*tmplFile]bool{}
	defines := map[string]map[*tmplFile]bool{}
	add := func(m map[string]map[*tmplFile]bool, name string, f *tmplFile) {
		if m[name] == nil {
			m[name] = map[*tmplFile]bool{}
		}
		m[name][f] = true
	}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if sqlext.SkipDir(rel, exclude) || skippedTemplateDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !templateExts[path.Ext(rel)] || sqlext.Excluded(rel, exclude) {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		f := &tmplFile{rel: rel}
		segs := strings.Split(rel, "/")
		for i := 0; i < len(segs)-1; i++ {
			if templateDirs[segs[i]] {
				below := strings.Join(segs[i+1:], "/")
				f.name = strings.TrimSuffix(below, path.Ext(below))
				add(names, below, f)
				add(names, f.name, f)
			}
		}
		// outside a templates directory, an .html file without actions is
		// a static page (an SPA's index.html), not a template
		if f.name == "" && !bytes.Contains(data, []byte("{{")) {
			return nil
		}
		add(names, path.Base(rel), f)
		for _, m := range defineRe.FindAllSubmatch(data, -1) {
			add(defines, string(m[1]), f)
		}
		for _, m := range templateRe.FindAllSubmatchIndex(data, -1) {
			line := 1 + bytes.Count(data[:m[0]], []byte("\n"))
			f.includes = append(f.includes, include{string(data[m[2]:m[3]]), line})
		}
		t.files = append(t.files, f)
		return nil
	})
	// a name used by more than one file (a path name, or a "content" block
	// every page defines) doesn't say which screen is meant, unless all but
	// one of them only define it
	for name, files := range names {
		if len(files) == 1 {
			for f := range files {
				t.byName[name] = f
			}
		}
	}
	for name, files := range defines {
		if _, ok := names[name]; ok || len(files) != 1 {
			continue
		}
		for f := range files {
			t.byName[name] = f
		}
	}
	// screen names must be unique: files outside a template dir, or whose
	// name collides with another file's, go by their repo path
	count := map[string]int{}
	for _, f := range t.files {
		if f.name != "" {
			count[f.name]++
		}
	}
	for _, f := range t.files {
		if f.name == "" || count[f.name] > 1 {
			f.name = strings.TrimSuffix(f.rel, path.Ext(f.rel))
		}
	}
	return t
}

// renderHint matches names of functions and fields that take a template name.
var renderHint = regexp.MustCompile(`(?i)render|templ|tmpl|tpl|html|view|page|layout|execute`)

// scanRenders adds a renders edge from every repo function passing a template
// name as a constant string argument to a call, or setting a struct field to
// one (Gitea's NewTemplate: tplHookNew).
//
// A name without a "/" ("home", "index.html") is also a config value, a
// translation key or a static file, so it counts only when it's of a named
// string type (Gitea's templates.TplName) or the function or field it goes to
// says it's about rendering (view.Render, ExecuteTemplate, TplName:). A path
// below a templates directory is specific enough on its own.
func (l *load) scanRenders() {
	t := l.x.tmpl
	if t == nil || len(t.byName) == 0 {
		return
	}
	vars := l.constVars()
	l.eachFunc(func(c *fnCtx, body ast.Node) {
		if !l.x.b.has(c.id) {
			return
		}
		info := c.p.TypesInfo
		value := func(e ast.Expr) (string, bool) {
			if s, ok := c.stringValue(e); ok {
				return s, true
			}
			var id *ast.Ident
			switch e := ast.Unparen(e).(type) {
			case *ast.Ident:
				id = e
			case *ast.SelectorExpr:
				id = e.Sel
			}
			if id != nil {
				if v, ok := info.Uses[id].(*types.Var); ok {
					s, ok := vars[v]
					return s, ok
				}
			}
			return "", false
		}
		check := func(e ast.Expr, hint string, at token.Pos) {
			s, ok := value(e)
			if !ok {
				return
			}
			f := t.lookup(s)
			if f == nil {
				return
			}
			if !strings.Contains(s, "/") && !renderHint.MatchString(hint) {
				if _, named := types.Unalias(info.TypeOf(e)).(*types.Named); !named {
					return
				}
			}
			t.rendered[f] = true
			file, line := l.pos(at)
			l.x.b.addEdge(graph.Edge{From: c.id, To: graph.ScreenID(f.name), Type: graph.Renders, File: file, Line: line})
		}
		ast.Inspect(body, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.CallExpr:
				var hint string
				switch f := ast.Unparen(n.Fun).(type) {
				case *ast.Ident:
					hint = f.Name
				case *ast.SelectorExpr:
					hint = f.Sel.Name
				}
				for _, a := range n.Args {
					check(a, hint, n.Pos())
				}
			case *ast.KeyValueExpr:
				if k, ok := n.Key.(*ast.Ident); ok {
					check(n.Value, k.Name, n.Pos())
				}
			}
			return true
		})
	})
}

// constVars returns the repo's package-level string variables initialised
// from a constant and never assigned or addressed elsewhere: constants in all
// but name (var tplTwofa templates.TplName = "user/auth/twofa").
func (l *load) constVars() map[*types.Var]string {
	vars := map[*types.Var]string{}
	changed := map[types.Object]bool{}
	for _, p := range l.plain {
		info := p.TypesInfo
		for _, file := range p.Syntax {
			for _, d := range file.Decls {
				gd, ok := d.(*ast.GenDecl)
				if !ok || gd.Tok != token.VAR {
					continue
				}
				for _, sp := range gd.Specs {
					vs := sp.(*ast.ValueSpec)
					if len(vs.Names) != len(vs.Values) {
						continue
					}
					for i, n := range vs.Names {
						if v, ok := info.Defs[n].(*types.Var); ok {
							if s, ok := constString(info, vs.Values[i]); ok {
								vars[v] = s
							}
						}
					}
				}
			}
		}
	}
	lhs := func(info *types.Info, e ast.Expr) {
		switch e := ast.Unparen(e).(type) {
		case *ast.Ident:
			changed[info.Uses[e]] = true
		case *ast.SelectorExpr:
			changed[info.Uses[e.Sel]] = true
		}
	}
	for _, p := range append(append([]*packages.Package{}, l.plain...), l.tests...) {
		for _, file := range p.Syntax {
			ast.Inspect(file, func(n ast.Node) bool {
				switch n := n.(type) {
				case *ast.AssignStmt:
					for _, e := range n.Lhs {
						lhs(p.TypesInfo, e)
					}
				case *ast.UnaryExpr:
					if n.Op == token.AND {
						lhs(p.TypesInfo, n.X)
					}
				}
				return true
			})
		}
	}
	for v := range vars {
		if changed[v] {
			delete(vars, v)
		}
	}
	return vars
}

// addScreens adds a node for every rendered template and, transitively, the
// partials it includes, with renders edges from screen to partial.
func (x *extractor) addScreens() {
	t := x.tmpl
	if t == nil || len(t.rendered) == 0 {
		return
	}
	var q []*tmplFile
	for _, f := range t.files {
		if t.rendered[f] {
			q = append(q, f)
		}
	}
	var dirs []string
	for len(q) > 0 {
		f := q[0]
		q = q[1:]
		x.b.addNode(graph.Node{ID: graph.ScreenID(f.name), Kind: graph.KindScreen, Label: f.name, Module: ScreensModule, File: f.rel, Line: 1, External: true})
		dirs = append(dirs, path.Dir(f.rel))
		for _, inc := range f.includes {
			if g := t.lookup(inc.name); g != nil {
				x.b.addEdge(graph.Edge{From: graph.ScreenID(f.name), To: graph.ScreenID(g.name), Type: graph.Renders, File: f.rel, Line: inc.line})
				if !t.rendered[g] {
					t.rendered[g] = true
					q = append(q, g)
				}
			}
		}
	}
	m := graph.Module{ID: ScreensModule, Label: "templates", Lang: "tmpl", External: true}
	sort.Strings(dirs)
	common := dirs[0]
	for _, d := range dirs[1:] {
		for common != "." && d != common && !strings.HasPrefix(d, common+"/") {
			common = path.Dir(common)
		}
	}
	if common != "." {
		m.Path = common
	}
	x.b.addModule(m)
}
