package goext

import (
	"go/ast"
	"go/token"
	"go/types"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/blatessa/codemap/internal/graph"
)

// CLI command detection. A command is a composite literal of one of:
//
//   - cobra's Command: the name is the first word of Use, the handlers are Run
//     and RunE, and parent.AddCommand(child) nests commands;
//   - urfave/cli's Command (v1–v3): the name is Name, the handler is Action, and
//     Subcommands/Commands nest commands;
//   - a repo struct type whose name contains "command" or "cmd", with a constant
//     name/Name/use/Use field and a function-typed field: run/Run/RunE/Action/
//     Exec/Handler, or the only function-typed field set. This covers the
//     command tables CLIs often build for themselves.
//
// Each command with a handler becomes an entry node named by its full path
// ("db migrate"). The root command's own name is usually the program's, so it
// is left out of its subcommands' names; a root is a command that Execute (or
// urfave v3's Run) is called on. Commands are followed through local and
// package variables and through repo functions that return them. A literal
// built in a loop over a table of structs (for _, t := range []T{…} { …
// Name: t.name … }) gives one command per table row.

// commandFramework returns "cobra", "urfave" or "repo" for a composite literal's
// type, or "" if it isn't a command.
func (l *load) commandFramework(t types.Type) string {
	if t == nil {
		return ""
	}
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	named, ok := t.(*types.Named)
	if !ok || named.Obj().Pkg() == nil {
		return ""
	}
	name, path := named.Obj().Name(), named.Obj().Pkg().Path()
	switch {
	case name == "Command" && path == "github.com/spf13/cobra":
		return "cobra"
	case name == "Command" && (path == "github.com/urfave/cli" || isMajorVersionOf(path, "github.com/urfave/cli")):
		return "urfave"
	}
	if _, ok := named.Underlying().(*types.Struct); !ok || !l.isRepoPkg(path) {
		return ""
	}
	lower := strings.ToLower(name)
	if strings.Contains(lower, "command") || strings.Contains(lower, "cmd") {
		return "repo"
	}
	return ""
}

// isMajorVersionOf reports whether path is base/vN.
func isMajorVersionOf(path, base string) bool {
	rest, ok := strings.CutPrefix(path, base+"/v")
	if !ok || rest == "" {
		return false
	}
	for _, r := range rest {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// cmdScope is where a command literal appears: a function body or a package
// variable's initializer.
type cmdScope struct {
	c      *fnCtx
	ranges map[types.Object]ast.Expr // range value variable → the ranged-over expression
}

// cmdLit is a command composite literal.
type cmdLit struct {
	lit      *ast.CompositeLit
	s        *cmdScope
	fw       string
	fields   map[string]ast.Expr
	parent   *cmdLit
	root     bool // Execute/Run is called on it
	file     string
	line     int
	handlers []ast.Expr
}

// cmdName is one name a command literal stands for, with its usage text.
type cmdName struct{ name, usage string }

type commandAnalyzer struct {
	l       *load
	cmds    map[*ast.CompositeLit]*cmdLit
	order   []*cmdLit
	pkgVars map[types.Object]varRef
	decls   map[*types.Func]funcRef
	scopes  map[*ast.FuncDecl]*cmdScope
	calls   []cmdCall
}

type varRef struct {
	s *cmdScope
	e ast.Expr
}

type funcRef struct {
	decl *ast.FuncDecl
	p    *packages.Package
	mod  string
}

// cmdCall is a cobra AddCommand or an Execute/Run call on a command.
type cmdCall struct {
	s    *cmdScope
	call *ast.CallExpr
	recv ast.Expr
}

// addCommands adds a node per CLI command with calls edges to its handlers.
func (l *load) addCommands() {
	a := &commandAnalyzer{
		l: l, cmds: map[*ast.CompositeLit]*cmdLit{}, pkgVars: map[types.Object]varRef{},
		decls: map[*types.Func]funcRef{}, scopes: map[*ast.FuncDecl]*cmdScope{},
	}
	for _, p := range l.plain {
		mod := l.moduleID(p.PkgPath)
		for _, f := range p.Syntax {
			rel, _ := l.pos(f.Pos())
			if rel == "" || l.fileExcluded(rel) {
				continue
			}
			for _, d := range f.Decls {
				switch d := d.(type) {
				case *ast.FuncDecl:
					if d.Body == nil {
						continue
					}
					if obj, ok := p.TypesInfo.Defs[d.Name].(*types.Func); ok {
						a.decls[obj] = funcRef{d, p, mod}
					}
					a.collect(a.funcScope(d, p, mod), d.Body)
				case *ast.GenDecl:
					if d.Tok != token.VAR {
						continue
					}
					s := &cmdScope{c: &fnCtx{p: p, mod: mod}}
					for _, spec := range d.Specs {
						vs := spec.(*ast.ValueSpec)
						for i, v := range vs.Values {
							if i < len(vs.Names) && len(vs.Names) == len(vs.Values) {
								if obj := p.TypesInfo.Defs[vs.Names[i]]; obj != nil {
									a.pkgVars[obj] = varRef{s, v}
								}
							}
							a.collect(s, v)
						}
					}
				}
			}
		}
	}
	for _, cl := range a.order {
		a.link(cl)
	}
	for _, k := range a.calls {
		parent := a.resolve(k.s, k.recv, 0)
		if parent == nil {
			continue
		}
		if k.call == nil {
			parent.root = true
			continue
		}
		for _, arg := range k.call.Args {
			if child := a.resolve(k.s, arg, 0); child != nil && child != parent {
				child.parent = parent
			}
		}
	}
	for _, cl := range a.order {
		a.emit(cl)
	}
}

func (a *commandAnalyzer) funcScope(d *ast.FuncDecl, p *packages.Package, mod string) *cmdScope {
	if s, ok := a.scopes[d]; ok {
		return s
	}
	id := ""
	if fn := a.l.ssaFor(d, p); fn != nil {
		id = a.l.idOf(fn)
	}
	obj, _ := p.TypesInfo.Defs[d.Name].(*types.Func)
	s := &cmdScope{c: newFnCtx(p, id, mod, obj, d.Type, d.Body), ranges: map[types.Object]ast.Expr{}}
	ast.Inspect(d.Body, func(n ast.Node) bool {
		if r, ok := n.(*ast.RangeStmt); ok && r.Tok == token.DEFINE {
			if id, ok := r.Value.(*ast.Ident); ok {
				if obj := p.TypesInfo.Defs[id]; obj != nil {
					s.ranges[obj] = r.X
				}
			}
		}
		return true
	})
	a.scopes[d] = s
	return s
}

// collect records the command literals under n, and the cobra AddCommand and
// Execute/Run calls that connect them.
func (a *commandAnalyzer) collect(s *cmdScope, n ast.Node) {
	info := s.c.p.TypesInfo
	ast.Inspect(n, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.CompositeLit:
			fw := a.l.commandFramework(info.TypeOf(v))
			if fw == "" {
				return true
			}
			cl := &cmdLit{lit: v, s: s, fw: fw, fields: litFields(info, v)}
			cl.file, cl.line = a.l.pos(v.Pos())
			a.cmds[v] = cl
			a.order = append(a.order, cl)
		case *ast.CallExpr:
			sel, ok := ast.Unparen(v.Fun).(*ast.SelectorExpr)
			if !ok {
				return true
			}
			fw := a.l.commandFramework(info.TypeOf(sel.X))
			if fw != "cobra" && fw != "urfave" {
				return true
			}
			switch {
			case fw == "cobra" && sel.Sel.Name == "AddCommand":
				a.calls = append(a.calls, cmdCall{s: s, call: v, recv: sel.X})
			case fw == "cobra" && strings.HasPrefix(sel.Sel.Name, "Execute"),
				fw == "urfave" && sel.Sel.Name == "Run":
				a.calls = append(a.calls, cmdCall{s: s, recv: sel.X})
			}
		}
		return true
	})
}

// litFields maps a struct literal's field names to their values, for keyed and
// positional literals.
func litFields(info *types.Info, lit *ast.CompositeLit) map[string]ast.Expr {
	out := map[string]ast.Expr{}
	t := info.TypeOf(lit)
	if t == nil {
		return out
	}
	if p, ok := t.Underlying().(*types.Pointer); ok {
		t = p.Elem()
	}
	st, ok := t.Underlying().(*types.Struct)
	if !ok {
		return out
	}
	for i, e := range lit.Elts {
		if kv, ok := e.(*ast.KeyValueExpr); ok {
			if id, ok := kv.Key.(*ast.Ident); ok {
				out[id.Name] = kv.Value
			}
		} else if i < st.NumFields() {
			out[st.Field(i).Name()] = e
		}
	}
	return out
}

// link finds a command's handlers and, for urfave/cli, attaches the
// subcommands listed in it.
func (a *commandAnalyzer) link(cl *cmdLit) {
	info := cl.s.c.p.TypesInfo
	switch cl.fw {
	case "cobra":
		cl.handlers = present(cl.fields, "Run", "RunE")
	case "urfave":
		cl.handlers = present(cl.fields, "Action")
		for _, key := range []string{"Subcommands", "Commands"} {
			list, s := a.sliceLit(cl.s, cl.fields[key], 0)
			if list == nil {
				continue
			}
			for _, e := range list.Elts {
				if child := a.resolve(s, e, 0); child != nil && child != cl {
					child.parent = cl
				}
			}
		}
	case "repo":
		var funcs []string
		for name, e := range cl.fields {
			// nil is untyped, so a field set to nil isn't counted.
			if t := info.TypeOf(e); t != nil && isFuncType(t) {
				funcs = append(funcs, name)
			}
		}
		sort.Strings(funcs)
		for _, name := range funcs {
			switch strings.ToLower(name) {
			case "run", "rune", "action", "exec", "execute", "handler", "handle":
				cl.handlers = append(cl.handlers, cl.fields[name])
			}
		}
		if len(cl.handlers) == 0 && len(funcs) == 1 {
			cl.handlers = []ast.Expr{cl.fields[funcs[0]]}
		}
	}
}

func isFuncType(t types.Type) bool {
	_, ok := t.Underlying().(*types.Signature)
	return ok
}

// present returns the values of the named fields that are set.
func present(fields map[string]ast.Expr, names ...string) []ast.Expr {
	var out []ast.Expr
	for _, n := range names {
		if e, ok := fields[n]; ok {
			out = append(out, e)
		}
	}
	return out
}

// follow returns the expression a local or package variable was last assigned,
// with the scope it's in, or e itself.
func (a *commandAnalyzer) follow(s *cmdScope, e ast.Expr) (*cmdScope, ast.Expr, bool) {
	id, ok := ast.Unparen(e).(*ast.Ident)
	if !ok {
		return s, e, false
	}
	obj := s.c.p.TypesInfo.Uses[id]
	if obj == nil {
		return s, e, false
	}
	if x, ok := s.c.exprs[obj]; ok && x != e {
		return s, x, true
	}
	if v, ok := a.pkgVars[obj]; ok && v.e != e {
		return v.s, v.e, true
	}
	return s, e, false
}

// resolve returns the command literal an expression evaluates to: the literal
// itself, a variable holding it, or a call of a repo function returning it.
func (a *commandAnalyzer) resolve(s *cmdScope, e ast.Expr, depth int) *cmdLit {
	if e == nil || depth > 6 {
		return nil
	}
	e = ast.Unparen(e)
	if u, ok := e.(*ast.UnaryExpr); ok && u.Op == token.AND {
		e = ast.Unparen(u.X)
	}
	switch v := e.(type) {
	case *ast.CompositeLit:
		return a.cmds[v]
	case *ast.Ident:
		if s2, x, ok := a.follow(s, v); ok {
			return a.resolve(s2, x, depth+1)
		}
	case *ast.CallExpr:
		f := staticCallee(s.c.p.TypesInfo, v)
		if f == nil {
			return nil
		}
		ref, ok := a.decls[f.Origin()]
		if !ok {
			return nil
		}
		fs := a.funcScope(ref.decl, ref.p, ref.mod)
		var found *cmdLit
		ast.Inspect(ref.decl.Body, func(n ast.Node) bool {
			if found != nil {
				return false
			}
			switch r := n.(type) {
			case *ast.FuncLit:
				return false // its returns aren't the function's
			case *ast.ReturnStmt:
				if len(r.Results) > 0 {
					found = a.resolve(fs, r.Results[0], depth+1)
				}
			}
			return true
		})
		return found
	}
	return nil
}

// sliceLit returns the slice literal an expression evaluates to.
func (a *commandAnalyzer) sliceLit(s *cmdScope, e ast.Expr, depth int) (*ast.CompositeLit, *cmdScope) {
	if e == nil || depth > 6 {
		return nil, nil
	}
	if lit, ok := ast.Unparen(e).(*ast.CompositeLit); ok {
		return lit, s
	}
	if s2, x, ok := a.follow(s, e); ok {
		return a.sliceLit(s2, x, depth+1)
	}
	return nil, nil
}

// names returns the names a command literal stands for: one, or one per row
// of the table a loop around it ranges over.
func (a *commandAnalyzer) names(cl *cmdLit) []cmdName {
	var nameKeys, usageKeys []string
	switch cl.fw {
	case "cobra":
		nameKeys, usageKeys = []string{"Use"}, []string{"Short"}
	case "urfave":
		nameKeys, usageKeys = []string{"Name"}, []string{"Usage"}
	default:
		nameKeys, usageKeys = []string{"name", "Name", "use", "Use"}, []string{"usage", "Usage", "short", "Short"}
	}
	var nameExpr, usageExpr ast.Expr
	useWord := false
	for _, k := range nameKeys {
		if e, ok := cl.fields[k]; ok {
			nameExpr, useWord = e, strings.EqualFold(k, "use")
			break
		}
	}
	for _, k := range usageKeys {
		if e, ok := cl.fields[k]; ok {
			usageExpr = e
			break
		}
	}
	if nameExpr == nil {
		return nil
	}
	mk := func(env map[types.Object]ast.Expr) (cmdName, bool) {
		name, ok := a.str(cl.s, nameExpr, env)
		if useWord {
			name, _, _ = strings.Cut(strings.TrimSpace(name), " ")
		}
		name = strings.Join(strings.Fields(name), " ")
		if !ok || name == "" {
			return cmdName{}, false
		}
		usage, _ := a.str(cl.s, usageExpr, env)
		return cmdName{name, usage}, true
	}
	if n, ok := mk(nil); ok {
		return []cmdName{n}
	}
	// A name read from a loop variable: one command per row of the table.
	obj := a.rangeVarIn(cl.s, nameExpr)
	if obj == nil {
		return nil
	}
	rows, _ := a.sliceLit(cl.s, cl.s.ranges[obj], 0)
	if rows == nil {
		return nil
	}
	var out []cmdName
	for _, row := range rows.Elts {
		if n, ok := mk(map[types.Object]ast.Expr{obj: row}); ok {
			out = append(out, n)
		}
	}
	return out
}

// rangeVarIn returns the range value variable e reads a field of, if any.
func (a *commandAnalyzer) rangeVarIn(s *cmdScope, e ast.Expr) types.Object {
	var found types.Object
	ast.Inspect(e, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && found == nil {
			if obj := s.c.p.TypesInfo.Uses[id]; obj != nil {
				if _, ok := s.ranges[obj]; ok {
					found = obj
				}
			}
		}
		return found == nil
	})
	return found
}

// str evaluates a string expression: constants, variables assigned once from a
// constant, concatenations, and fields of the table row bound in env.
func (a *commandAnalyzer) str(s *cmdScope, e ast.Expr, env map[types.Object]ast.Expr) (string, bool) {
	if e == nil {
		return "", false
	}
	if v, ok := s.c.stringValue(e); ok {
		return v, true
	}
	info := s.c.p.TypesInfo
	switch v := ast.Unparen(e).(type) {
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			return "", false
		}
		x, ok1 := a.str(s, v.X, env)
		y, ok2 := a.str(s, v.Y, env)
		return x + y, ok1 && ok2
	case *ast.SelectorExpr:
		id, ok := ast.Unparen(v.X).(*ast.Ident)
		if !ok {
			return "", false
		}
		row, ok := env[info.Uses[id]]
		if !ok {
			return "", false
		}
		row = ast.Unparen(row)
		if u, ok := row.(*ast.UnaryExpr); ok && u.Op == token.AND {
			row = u.X
		}
		lit, ok := row.(*ast.CompositeLit)
		if !ok {
			return "", false
		}
		return a.str(s, litFields(info, lit)[v.Sel.Name], nil)
	}
	return "", false
}

// path returns the names of a command's ancestors below the root, outermost
// first. It fails if an ancestor's name isn't known.
func (a *commandAnalyzer) path(cl *cmdLit) ([]string, bool) {
	var out []string
	seen := map[*cmdLit]bool{cl: true}
	for p := cl.parent; p != nil && !seen[p]; p = p.parent {
		seen[p] = true
		if p.root && p.parent == nil {
			break
		}
		ns := a.names(p)
		if len(ns) == 0 {
			return nil, false
		}
		out = append([]string{ns[0].name}, out...)
	}
	return out, true
}

func (a *commandAnalyzer) emit(cl *cmdLit) {
	if len(cl.handlers) == 0 {
		return // a group of subcommands, not something that runs
	}
	names := a.names(cl)
	prefix, ok := a.path(cl)
	if len(names) == 0 || !ok {
		return // a name that isn't constant: don't guess
	}
	var hs handlerSet
	for _, h := range cl.handlers {
		hs.merge(a.l.resolveHandler(cl.s.c, h, 0))
	}
	for _, n := range names {
		full := strings.Join(append(append([]string{}, prefix...), n.name), " ")
		id := graph.CommandID(full)
		var fields map[string]any
		if n.usage != "" {
			fields = map[string]any{"usage": n.usage}
		}
		a.l.x.b.addNode(graph.Node{
			ID: id, Kind: graph.KindCommand, Label: full, Module: cl.s.c.mod,
			File: cl.file, Line: cl.line, Entry: true, Fields: fields,
		})
		for _, to := range hs.all() {
			a.l.x.b.addEdge(graph.Edge{From: id, To: to, Type: graph.Calls, File: cl.file, Line: cl.line})
		}
	}
}
