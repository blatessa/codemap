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
//
// Two simpler dispatch styles are recognised too:
//
//   - a map from constant strings to functions, whose variable or type name
//     contains "command" or "cmd": map literal entries and index assignments
//     (commands["serve"] = runServe), with the value as the handler;
//   - a switch over the program's arguments (os.Args[i], flag.Arg(i), or a
//     local taken from those or from os.Args[1:] / flag.Args()): each constant
//     case is a command, and the calls in its body are its handlers. Cases
//     starting with "-" are flags, not commands.

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
	simple  []simpleCmd
}

// simpleCmd is a command from a map entry or a switch case.
type simpleCmd struct {
	s    *cmdScope
	name string
	pos  token.Pos
	hs   handlerSet
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
						if len(vs.Names) == len(vs.Values) {
							for i, v := range vs.Values {
								if obj := p.TypesInfo.Defs[vs.Names[i]]; obj != nil {
									a.pkgVars[obj] = varRef{s, v}
								}
							}
						}
						a.collect(s, vs)
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
	for _, sc := range a.simple {
		file, line := l.pos(sc.pos)
		a.add(sc.s, sc.name, "", file, line, sc.hs)
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

// collect records the command literals under n, the cobra AddCommand and
// Execute/Run calls that connect them, and commands registered in maps or
// dispatched by switches.
func (a *commandAnalyzer) collect(s *cmdScope, n ast.Node) {
	info := s.c.p.TypesInfo
	ast.Inspect(n, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.ValueSpec:
			if len(v.Names) == len(v.Values) {
				for i, name := range v.Names {
					a.mapLit(s, name.Name, v.Values[i])
				}
			}
		case *ast.AssignStmt:
			if len(v.Lhs) == len(v.Rhs) {
				for i, lhs := range v.Lhs {
					a.mapAssign(s, lhs, v.Rhs[i])
				}
			}
		case *ast.SwitchStmt:
			a.argSwitch(s, v)
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
		a.add(cl.s, full, n.usage, cl.file, cl.line, hs)
	}
}

// add adds a command node with calls edges to its handlers.
func (a *commandAnalyzer) add(s *cmdScope, name, usage, file string, line int, hs handlerSet) {
	id := graph.CommandID(name)
	var fields map[string]any
	if usage != "" {
		fields = map[string]any{"usage": usage}
	}
	a.l.x.b.addNode(graph.Node{
		ID: id, Kind: graph.KindCommand, Label: name, Module: s.c.mod,
		File: file, Line: line, Entry: true, Fields: fields,
	})
	for _, to := range hs.all() {
		a.l.x.b.addEdge(graph.Edge{From: id, To: to, Type: graph.Calls, File: file, Line: line})
	}
}

// commandish reports whether a name suggests it holds commands.
func commandish(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "command") || strings.Contains(lower, "cmd")
}

// isCommandMap reports whether t is a map from strings to functions that is
// named, or held in a variable named, like a command registry.
func isCommandMap(t types.Type, varName string) bool {
	if t == nil {
		return false
	}
	m, ok := t.Underlying().(*types.Map)
	if !ok || !isFuncType(m.Elem()) {
		return false
	}
	if k, ok := m.Key().Underlying().(*types.Basic); !ok || k.Info()&types.IsString == 0 {
		return false
	}
	if named, ok := t.(*types.Named); ok && commandish(named.Obj().Name()) {
		return true
	}
	return commandish(varName)
}

// mapLit records the entries of a command map literal assigned to a variable.
func (a *commandAnalyzer) mapLit(s *cmdScope, varName string, e ast.Expr) {
	lit, ok := ast.Unparen(e).(*ast.CompositeLit)
	if !ok || !isCommandMap(s.c.p.TypesInfo.TypeOf(lit), varName) {
		return
	}
	for _, elt := range lit.Elts {
		if kv, ok := elt.(*ast.KeyValueExpr); ok {
			a.mapEntry(s, kv.Key, kv.Value, kv.Pos())
		}
	}
}

// mapAssign records commands[name] = handler, and command maps assigned whole.
func (a *commandAnalyzer) mapAssign(s *cmdScope, lhs, rhs ast.Expr) {
	switch v := ast.Unparen(lhs).(type) {
	case *ast.Ident:
		a.mapLit(s, v.Name, rhs)
	case *ast.IndexExpr:
		var name string
		switch x := ast.Unparen(v.X).(type) {
		case *ast.Ident:
			name = x.Name
		case *ast.SelectorExpr:
			name = x.Sel.Name
		}
		if isCommandMap(s.c.p.TypesInfo.TypeOf(v.X), name) {
			a.mapEntry(s, v.Index, rhs, lhs.Pos())
		}
	}
}

func (a *commandAnalyzer) mapEntry(s *cmdScope, key, handler ast.Expr, pos token.Pos) {
	if name, ok := cmdKey(s, key); ok {
		a.simple = append(a.simple, simpleCmd{s: s, name: name, pos: pos, hs: a.l.resolveHandler(s.c, handler, 0)})
	}
}

// cmdKey returns a constant command name; flags ("-h", "--help") aren't commands.
func cmdKey(s *cmdScope, e ast.Expr) (string, bool) {
	name, ok := s.c.stringValue(e)
	name = strings.Join(strings.Fields(name), " ")
	return name, ok && name != "" && !strings.HasPrefix(name, "-")
}

// argSwitch records a command per constant case of a switch over the
// program's arguments, with the calls in the case body as its handlers.
func (a *commandAnalyzer) argSwitch(s *cmdScope, sw *ast.SwitchStmt) {
	if sw.Tag == nil || !a.isArg(s, sw.Tag, 0) {
		return
	}
	for _, st := range sw.Body.List {
		cc := st.(*ast.CaseClause)
		var hs handlerSet
		seen := map[string]bool{}
		for _, b := range cc.Body {
			ast.Inspect(b, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				for _, t := range a.l.sites[call.Lparen] {
					id := a.l.idOf(t)
					if id != "" && id != s.c.id && !seen[id] && a.l.x.b.has(id) && a.l.repoCode(t) && !a.l.isTestCode(t) {
						seen[id] = true
						hs.callees = append(hs.callees, id)
					}
				}
				return true
			})
		}
		for _, e := range cc.List {
			if name, ok := cmdKey(s, e); ok {
				a.simple = append(a.simple, simpleCmd{s: s, name: name, pos: cc.Pos(), hs: hs})
			}
		}
	}
}

// isArg reports whether e is one of the program's arguments: os.Args[i],
// flag.Arg(i), an element of os.Args[1:] or flag.Args(), or a local variable
// assigned one of those.
func (a *commandAnalyzer) isArg(s *cmdScope, e ast.Expr, depth int) bool {
	if depth > 6 {
		return false
	}
	switch v := ast.Unparen(e).(type) {
	case *ast.IndexExpr:
		return a.isArgs(s, v.X, depth+1)
	case *ast.CallExpr:
		return isFlagFunc(s.c.p.TypesInfo, v, "Arg")
	case *ast.Ident:
		if _, ok := s.c.exprs[s.c.p.TypesInfo.Uses[v]]; ok {
			_, x, _ := a.follow(s, v)
			return a.isArg(s, x, depth+1)
		}
	}
	return false
}

// isArgs reports whether e is the program's argument list: os.Args, a slice of
// it, flag.Args(), or a local variable assigned one of those.
func (a *commandAnalyzer) isArgs(s *cmdScope, e ast.Expr, depth int) bool {
	if depth > 6 {
		return false
	}
	info := s.c.p.TypesInfo
	switch v := ast.Unparen(e).(type) {
	case *ast.SelectorExpr:
		obj, ok := info.Uses[v.Sel].(*types.Var)
		return ok && obj.Pkg() != nil && obj.Pkg().Path() == "os" && obj.Name() == "Args"
	case *ast.SliceExpr:
		return a.isArgs(s, v.X, depth+1)
	case *ast.CallExpr:
		return isFlagFunc(info, v, "Args")
	case *ast.Ident:
		if _, ok := s.c.exprs[info.Uses[v]]; ok {
			_, x, _ := a.follow(s, v)
			return a.isArgs(s, x, depth+1)
		}
	}
	return false
}

// isFlagFunc reports whether call is flag.<name>() or (*flag.FlagSet).<name>().
func isFlagFunc(info *types.Info, call *ast.CallExpr, name string) bool {
	f := staticCallee(info, call)
	return f != nil && f.Pkg() != nil && f.Pkg().Path() == "flag" && f.Name() == name
}
