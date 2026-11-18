package goext

import (
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"path"
	"sort"
	"strconv"
	"strings"
)

// Route helpers: functions and closures that take a path (and usually a
// handler) and register it, often with a prefix or a method split off:
//
//	p := func(pattern string, h func(…)) {
//		method, path, _ := strings.Cut(pattern, " ")
//		mux.HandleFunc(method+" /{project}/api"+path, wrap(func(…) { h(…) }))
//	}
//	p("GET /state", func(…) {…})
//
// A helper is analysed once per call site with its parameters bound to what
// the call site passes: routers, constant strings, and functions. Paths are
// evaluated as string expressions over those bindings, and a bound function
// parameter resolves, as a handler, to the call site's argument.

// binding is what a parameter is bound to for one call site, or a range
// loop's value variable for one iteration.
type binding struct {
	r     *rnode // a router
	str   string // a constant string, when isStr
	isStr bool
	fn    ast.Expr // a function or handler value, resolved in from
	from  *rscope
	elem  ast.Expr // the element of a range over a composite literal
}

// rangeElems returns the value variable and elements of a range over a
// composite literal of at most 64 elements whose value is passed to a call in
// the loop body, or nil.
func (a *routeAnalyzer) rangeElems(s *ast.RangeStmt, sc *rscope) (types.Object, []ast.Expr) {
	info := sc.p.TypesInfo
	id, ok := s.Value.(*ast.Ident)
	if !ok || s.Tok != token.DEFINE {
		return nil, nil
	}
	v := info.Defs[id]
	x := ast.Unparen(s.X)
	if xid, ok := x.(*ast.Ident); ok {
		if d, ok := a.defsOf(sc.fnCtx)[info.Uses[xid]]; ok && d.x != nil && d.idx < 0 {
			x = ast.Unparen(d.x) // routes := []route{…}; for _, r := range routes
		}
	}
	cl, ok := x.(*ast.CompositeLit)
	if v == nil || !ok || len(cl.Elts) == 0 || len(cl.Elts) > 64 {
		return nil, nil
	}
	if _, ok := info.TypeOf(cl).Underlying().(*types.Map); ok {
		return nil, nil
	}
	used := false
	ast.Inspect(s.Body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			for _, x := range call.Args {
				ast.Inspect(x, func(n ast.Node) bool {
					if id, ok := n.(*ast.Ident); ok && info.Uses[id] == v {
						used = true
					}
					return !used
				})
			}
		}
		return !used
	})
	if !used {
		return nil, nil
	}
	elems := make([]ast.Expr, len(cl.Elts))
	for i, e := range cl.Elts {
		if kv, ok := e.(*ast.KeyValueExpr); ok {
			e = kv.Value // [...]string{0: "/a"}
		}
		elems[i] = e
	}
	return v, elems
}

// elemValue returns the expression a range element variable, or a field of
// one, stands for in this iteration: r → {"/a", h}, r.path → "/a". Or nil.
func (a *routeAnalyzer) elemValue(x ast.Expr, sc *rscope) ast.Expr {
	info := sc.p.TypesInfo
	switch v := ast.Unparen(x).(type) {
	case *ast.Ident:
		if b, ok := sc.boundArg(info.Uses[v]); ok && b.elem != nil {
			return b.elem
		}
	case *ast.SelectorExpr:
		outer := a.elemValue(v.X, sc)
		if u, ok := outer.(*ast.UnaryExpr); ok && u.Op == token.AND {
			outer = u.X
		}
		cl, ok := outer.(*ast.CompositeLit)
		if !ok {
			return nil
		}
		st, ok := info.TypeOf(cl).Underlying().(*types.Struct)
		if !ok {
			return nil
		}
		for i, e := range cl.Elts {
			if kv, ok := e.(*ast.KeyValueExpr); ok {
				if k, ok := kv.Key.(*ast.Ident); ok && k.Name == v.Sel.Name {
					return kv.Value
				}
			} else if i < st.NumFields() && st.Field(i).Name() == v.Sel.Name {
				return e
			}
		}
	}
	return nil
}

// argsKey identifies a set of bindings for memoising analyses.
func argsKey(params map[int]binding) string {
	idx := make([]int, 0, len(params))
	for i := range params {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	var b strings.Builder
	for _, i := range idx {
		switch p := params[i]; {
		case p.r != nil:
			fmt.Fprintf(&b, "|%d:%p", i, p.r)
		case p.isStr:
			fmt.Fprintf(&b, "|%d:%q", i, p.str)
		case p.fn != nil:
			fmt.Fprintf(&b, "|%d:f%p", i, p.fn)
		}
	}
	return b.String()
}

// callArgs evaluates a call's arguments to bindings by parameter index:
// routers always, and for route helpers also constant strings and functions.
func (a *routeAnalyzer) callArgs(call *ast.CallExpr, sig *types.Signature, sc *rscope, helper bool) map[int]binding {
	var m map[int]binding
	set := func(i int, b binding) {
		if m == nil {
			m = map[int]binding{}
		}
		m[i] = b
	}
	for i, x := range call.Args {
		if r := a.eval(x, sc); r != nil {
			set(i, binding{r: r})
			continue
		}
		n := sig.Params().Len()
		if !helper || i >= n || sig.Variadic() && i >= n-1 {
			continue
		}
		if s, ok := a.str(x, sc); ok {
			set(i, binding{str: s, isStr: true})
		} else if t := sig.Params().At(i).Type(); handlerish(t) {
			set(i, binding{fn: x, from: sc})
		}
	}
	return m
}

func hasStr(params map[int]binding) bool {
	for _, p := range params {
		if p.isStr {
			return true
		}
	}
	return false
}

func hasRouter(params map[int]binding) bool {
	for _, p := range params {
		if p.r != nil {
			return true
		}
	}
	return false
}

// bindParams binds a function's parameters in sc.
func bindParams(ft *ast.FuncType, info *types.Info, params map[int]binding, sc *rscope) {
	i := 0
	for _, field := range ft.Params.List {
		if len(field.Names) == 0 {
			i++
			continue
		}
		for _, n := range field.Names {
			if b, ok := params[i]; ok {
				if o := info.Defs[n]; o != nil {
					if b.r != nil {
						sc.vars[o] = b.r
					} else {
						if sc.bound == nil {
							sc.bound = map[types.Object]binding{}
						}
						sc.bound[o] = b
					}
				}
			}
			i++
		}
	}
}

func (s *rscope) boundArg(o types.Object) (binding, bool) {
	for sc := s; sc != nil; sc = sc.parent {
		if b, ok := sc.bound[o]; ok {
			return b, true
		}
	}
	return binding{}, false
}

// declHelper reports whether f is a route helper declared in the repo. The
// repo's router types' own methods aren't: their calls are read by convention.
func (a *routeAnalyzer) declHelper(f *types.Func) bool {
	ref, ok := a.decls[f.Origin()]
	if !ok || a.wrapperMethod(f) {
		return false
	}
	return a.routeHelper(ref.decl.Type, ref.decl.Body, ref.p.TypesInfo, nil)
}

// routeHelper reports whether a function's string parameters flow, through
// local variables, into the arguments of a route registration or of another
// route helper. exprs maps the local variables in scope to their values, to
// find closures called by name; nil computes it from body.
func (a *routeAnalyzer) routeHelper(ft *ast.FuncType, body *ast.BlockStmt, info *types.Info, exprs map[types.Object]ast.Expr) bool {
	if v, ok := a.helpers[body]; ok {
		return v
	}
	a.helpers[body] = false // while computing: recursion isn't a helper
	taint := map[types.Object]bool{}
	for _, f := range ft.Params.List {
		for _, n := range f.Names {
			if o := info.Defs[n]; o != nil && isString(info, n) {
				taint[o] = true
			}
		}
	}
	if len(taint) == 0 {
		return false
	}
	if exprs == nil {
		exprs, _ = localExprs(body, info)
	}
	mentions := func(n ast.Node) bool {
		hit := false
		ast.Inspect(n, func(n ast.Node) bool {
			if id, ok := n.(*ast.Ident); ok && taint[info.Uses[id]] {
				hit = true
			}
			return !hit
		})
		return hit
	}
	type assign struct {
		lhs []ast.Expr
		rhs []ast.Expr
	}
	var assigns []assign
	ast.Inspect(body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			assigns = append(assigns, assign{s.Lhs, s.Rhs})
		case *ast.ValueSpec:
			var lhs []ast.Expr
			for _, n := range s.Names {
				lhs = append(lhs, n)
			}
			assigns = append(assigns, assign{lhs, s.Values})
		}
		return true
	})
	for changed := true; changed; {
		changed = false
		for _, as := range assigns {
			hit := false
			for _, x := range as.rhs {
				hit = hit || mentions(x)
			}
			if !hit {
				continue
			}
			for _, l := range as.lhs {
				if id, ok := ast.Unparen(l).(*ast.Ident); ok {
					if o := objOf(info, id); o != nil && !taint[o] {
						taint[o] = true
						changed = true
					}
				}
			}
		}
	}
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if found || !ok {
			return !found
		}
		hit := false
		for _, x := range call.Args {
			hit = hit || mentions(x)
		}
		if !hit {
			return true
		}
		if sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr); ok && a.isRouter(info.TypeOf(sel.X)) {
			found = true
		} else if f := staticCallee(info, call); f != nil {
			if f.Pkg() != nil && framework(f.Pkg().Path()) == "nethttp" && f.Signature().Recv() == nil && (f.Name() == "Handle" || f.Name() == "HandleFunc") {
				found = true
			} else if a.declHelper(f) {
				found = true
			}
		} else if id, ok := ast.Unparen(call.Fun).(*ast.Ident); ok {
			if lit, ok := ast.Unparen(exprs[info.Uses[id]]).(*ast.FuncLit); ok && a.routeHelper(lit.Type, lit.Body, info, exprs) {
				found = true
			}
		}
		return !found
	})
	a.helpers[body] = found
	return found
}

// localHelper returns the route helper closure a call calls by name, or nil.
func (a *routeAnalyzer) localHelper(call *ast.CallExpr, c *fnCtx) *ast.FuncLit {
	id, ok := ast.Unparen(call.Fun).(*ast.Ident)
	if !ok || len(call.Args) == 0 {
		return nil
	}
	info := c.p.TypesInfo
	lit, ok := ast.Unparen(c.exprs[info.Uses[id]]).(*ast.FuncLit)
	if !ok || !a.routeHelper(lit.Type, lit.Body, info, c.exprs) {
		return nil
	}
	return lit
}

// strDef is a local variable's only assignment.
type strDef struct {
	x   ast.Expr // nil when assigned more than once, or a bound parameter assigned to
	idx int      // the result index when x returns several (strings.Cut), else -1 or rangeVar
}

const rangeVar = -2 // a range loop's variable, assigned only by the loop

// stringDefs maps the local variables in body (and parameters assigned to) to
// their assignments.
func stringDefs(body ast.Node, info *types.Info) map[types.Object]strDef {
	defs := map[types.Object]strDef{}
	count := map[types.Object]int{}
	note := func(id *ast.Ident, x ast.Expr, idx int) {
		if o := objOf(info, id); o != nil {
			count[o]++
			defs[o] = strDef{x, idx}
		}
	}
	ast.Inspect(body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			for i, l := range s.Lhs {
				id, ok := ast.Unparen(l).(*ast.Ident)
				if !ok {
					continue
				}
				switch {
				case s.Tok != token.DEFINE && s.Tok != token.ASSIGN:
					note(id, nil, -1) // x += …
				case len(s.Lhs) == len(s.Rhs):
					note(id, s.Rhs[i], -1)
				case len(s.Rhs) == 1:
					note(id, s.Rhs[0], i)
				default:
					note(id, nil, -1)
				}
			}
		case *ast.ValueSpec:
			for i, id := range s.Names {
				switch {
				case len(s.Names) == len(s.Values):
					note(id, s.Values[i], -1)
				case len(s.Values) == 1:
					note(id, s.Values[0], i)
				default:
					note(id, nil, -1)
				}
			}
		case *ast.RangeStmt:
			for _, x := range []ast.Expr{s.Key, s.Value} {
				if id, ok := x.(*ast.Ident); ok {
					note(id, nil, rangeVar)
				}
			}
		case *ast.UnaryExpr:
			if id, ok := s.X.(*ast.Ident); ok && s.Op == token.AND {
				note(id, nil, -1) // &x: may be changed elsewhere
			}
		}
		return true
	})
	for o, n := range count {
		if n > 1 {
			defs[o] = strDef{idx: -1}
		}
	}
	return defs
}

func (a *routeAnalyzer) defsOf(c *fnCtx) map[types.Object]strDef {
	body := a.bodies[c]
	if body == nil {
		return nil
	}
	d, ok := a.defs[body]
	if !ok {
		d = stringDefs(body, c.p.TypesInfo)
		a.defs[body] = d
	}
	return d
}

// str evaluates a string expression: constants, the scope's bound string
// parameters, local variables assigned once, +, and a few library functions
// (strings.Cut, TrimPrefix and TrimSuffix, fmt.Sprintf with %s/%v/%d, and
// path.Join). Anything else isn't a constant.
func (a *routeAnalyzer) str(e ast.Expr, sc *rscope) (string, bool) {
	return a.strAt(e, sc, 0)
}

func (a *routeAnalyzer) strAt(e ast.Expr, sc *rscope, depth int) (string, bool) {
	info := sc.p.TypesInfo
	if s, ok := constString(info, e); ok {
		return s, true
	}
	if depth > 12 {
		return "", false
	}
	switch v := ast.Unparen(e).(type) {
	case *ast.Ident:
		o := info.Uses[v]
		if o == nil {
			return "", false
		}
		defs := a.defsOf(sc.fnCtx)
		if defs == nil {
			return sc.stringValue(v)
		}
		d, assigned := defs[o]
		if d.idx == rangeVar {
			if e := a.elemValue(v, sc); e != nil {
				return a.strAt(e, sc, depth+1)
			}
			return "", false
		}
		if b, ok := sc.boundArg(o); ok && !assigned {
			return b.str, b.isStr
		}
		if !assigned || d.x == nil {
			return "", false
		}
		if d.idx < 0 {
			return a.strAt(d.x, sc, depth+1)
		}
		return a.strResult(d.x, d.idx, sc, depth+1)
	case *ast.SelectorExpr:
		if e := a.elemValue(v, sc); e != nil {
			return a.strAt(e, sc, depth+1) // r.path ranging over []route{{"/a", …}}
		}
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			return "", false
		}
		x, ok := a.strAt(v.X, sc, depth+1)
		if !ok {
			return "", false
		}
		y, ok := a.strAt(v.Y, sc, depth+1)
		return x + y, ok
	case *ast.CallExpr:
		return a.strCall(v, sc, depth+1)
	}
	return "", false
}

// strArgs evaluates all of a call's arguments.
func (a *routeAnalyzer) strArgs(args []ast.Expr, sc *rscope, depth int) ([]string, bool) {
	out := make([]string, len(args))
	for i, x := range args {
		s, ok := a.strAt(x, sc, depth)
		if !ok {
			return nil, false
		}
		out[i] = s
	}
	return out, true
}

func (a *routeAnalyzer) strCall(call *ast.CallExpr, sc *rscope, depth int) (string, bool) {
	info := sc.p.TypesInfo
	if tv, ok := info.Types[call.Fun]; ok && tv.IsType() && len(call.Args) == 1 && isString(info, call.Args[0]) {
		return a.strAt(call.Args[0], sc, depth) // string(x), a named string type
	}
	f := staticCallee(info, call)
	if f == nil || f.Pkg() == nil || f.Signature().Recv() != nil || call.Ellipsis.IsValid() {
		return "", false
	}
	switch f.Pkg().Path() + "." + f.Name() {
	case "strings.TrimPrefix", "strings.TrimSuffix":
		args, ok := a.strArgs(call.Args, sc, depth)
		if !ok || len(args) != 2 {
			return "", false
		}
		if f.Name() == "TrimPrefix" {
			return strings.TrimPrefix(args[0], args[1]), true
		}
		return strings.TrimSuffix(args[0], args[1]), true
	case "path.Join":
		args, ok := a.strArgs(call.Args, sc, depth)
		if !ok {
			return "", false
		}
		return path.Join(args...), true
	case "fmt.Sprintf":
		if len(call.Args) == 0 {
			return "", false
		}
		format, ok := a.strAt(call.Args[0], sc, depth)
		if !ok {
			return "", false
		}
		return a.sprintf(format, call.Args[1:], sc, depth)
	}
	return "", false
}

// strResult evaluates result idx of a call returning several values:
// before, after, _ := strings.Cut(s, sep).
func (a *routeAnalyzer) strResult(x ast.Expr, idx int, sc *rscope, depth int) (string, bool) {
	call, ok := ast.Unparen(x).(*ast.CallExpr)
	if !ok || idx > 1 {
		return "", false
	}
	f := staticCallee(sc.p.TypesInfo, call)
	if f == nil || f.Pkg() == nil || f.Pkg().Path() != "strings" || f.Name() != "Cut" {
		return "", false
	}
	args, ok := a.strArgs(call.Args, sc, depth)
	if !ok || len(args) != 2 {
		return "", false
	}
	before, after, _ := strings.Cut(args[0], args[1])
	if idx == 0 {
		return before, true
	}
	return after, true
}

// sprintf formats with the verbs %s, %v and %d (no flags or widths) and %%.
func (a *routeAnalyzer) sprintf(format string, args []ast.Expr, sc *rscope, depth int) (string, bool) {
	info := sc.p.TypesInfo
	var b strings.Builder
	for i := 0; i < len(format); i++ {
		c := format[i]
		if c != '%' {
			b.WriteByte(c)
			continue
		}
		if i++; i == len(format) {
			return "", false
		}
		verb := format[i]
		if verb == '%' {
			b.WriteByte('%')
			continue
		}
		if len(args) == 0 {
			return "", false
		}
		x := args[0]
		args = args[1:]
		var s string
		var ok bool
		tv := info.Types[x]
		switch {
		case verb == 'd':
			if tv.Value != nil && tv.Value.Kind() == constant.Int {
				s, ok = tv.Value.ExactString(), true
			}
		case verb == 's' || verb == 'v':
			if s, ok = a.strAt(x, sc, depth); !ok && tv.Value != nil {
				switch tv.Value.Kind() {
				case constant.Int:
					s, ok = tv.Value.ExactString(), true
				case constant.Bool:
					s, ok = strconv.FormatBool(constant.BoolVal(tv.Value)), true
				}
			}
		}
		if !ok {
			return "", false
		}
		b.WriteString(s)
	}
	return b.String(), len(args) == 0
}

// resolveIn resolves a handler expression in a scope that may bind function
// parameters. A bound parameter the expression calls or passes on resolves to
// the call site's argument, rather than to whatever the call graph says any
// caller passes.
func (a *routeAnalyzer) resolveIn(x ast.Expr, sc *rscope, depth int) handlerSet {
	if e := a.elemValue(x, sc); e != nil && depth < 4 {
		return a.resolveIn(e, sc, depth+1) // r.h ranging over []route{{"/a", h}}
	}
	bound := a.boundFuncs(x, sc)
	if len(bound) == 0 {
		return a.l.resolveHandler(sc.fnCtx, x, 0)
	}
	skip := map[token.Pos]bool{}
	for _, o := range bound {
		skip[o.Pos()] = true
	}
	hs := a.l.resolveHandlerSkip(sc.fnCtx, x, 0, skip)
	if depth < 4 {
		for _, o := range bound {
			b, _ := sc.boundArg(o)
			hs.merge(a.resolveIn(b.fn, b.from, depth+1))
		}
	}
	return hs
}

// boundFuncs returns the bound function parameters used in x, including in
// closures it refers to by name.
func (a *routeAnalyzer) boundFuncs(x ast.Expr, sc *rscope) []types.Object {
	info := sc.p.TypesInfo
	var out []types.Object
	seen := map[types.Object]bool{}
	var visit func(n ast.Node)
	visit = func(n ast.Node) {
		ast.Inspect(n, func(n ast.Node) bool {
			id, ok := n.(*ast.Ident)
			if !ok {
				return true
			}
			o := info.Uses[id]
			if o == nil || seen[o] {
				return true
			}
			seen[o] = true
			if b, ok := sc.boundArg(o); ok && b.fn != nil {
				out = append(out, o)
			} else if lit, ok := ast.Unparen(sc.exprs[o]).(*ast.FuncLit); ok {
				visit(lit)
			}
			return true
		})
	}
	visit(x)
	return out
}
