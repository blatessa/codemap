package goext

import (
	"go/ast"
	"go/types"
	"strings"
)

// The repo's own router types. Many repos wrap a router library in a type of
// their own (Gitea's web.Router around chi) to add conventions: middleware as
// handler arguments, groups that take a callback, route builders. Wrappers keep
// the method names of the libraries they wrap, so their methods are read by
// those conventions:
//
//	Get/Post/… (path, handlers…)        a route; the last handler is the endpoint
//	Get/Post/… (handlers…)              on a route builder: a route at its path
//	Any/Handle/HandleFunc (path, h…)    a route for any method
//	Methods/Method/Match/Add (methods, path, h…)
//	Group/Route/Prefix (path, callback, middleware…)
//	                                    a group; the callback registers on it,
//	                                    through its router parameter or (with
//	                                    none) the router it was called on
//	Group/Route/Prefix/With (…) returning a router type
//	                                    a group, or a route builder (Combo(path))
//	Mount (path, router)                a sub-router
//	Use (middleware…)                   middleware for later routes
//
// What the wrapper's methods do inside isn't analysed: the calls they make
// pass their path along as a parameter, which isn't a constant.

// routerWrappers finds the repo's struct types that hold a router: a field of
// a router library's type, or of another such struct.
func (l *load) routerWrappers() map[*types.TypeName]bool {
	var cands []*types.TypeName
	for _, p := range l.plain {
		sc := p.Types.Scope()
		for _, n := range sc.Names() {
			if tn, ok := sc.Lookup(n).(*types.TypeName); ok && !tn.IsAlias() {
				if _, ok := tn.Type().Underlying().(*types.Struct); ok {
					cands = append(cands, tn)
				}
			}
		}
	}
	out := map[*types.TypeName]bool{}
	isRouter := func(t types.Type) bool {
		if isRouterType(t) {
			return true
		}
		if p, ok := t.(*types.Pointer); ok {
			t = p.Elem()
		}
		n, ok := types.Unalias(t).(*types.Named)
		return ok && out[n.Obj()]
	}
	for changed := true; changed; {
		changed = false
		for _, tn := range cands {
			if out[tn] {
				continue
			}
			st := tn.Type().Underlying().(*types.Struct)
			for i := range st.NumFields() {
				if isRouter(st.Field(i).Type()) {
					out[tn] = true
					changed = true
					break
				}
			}
		}
	}
	return out
}

func (a *routeAnalyzer) isWrapper(t types.Type) bool {
	if t == nil {
		return false
	}
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	n, ok := types.Unalias(t).(*types.Named)
	return ok && a.wrappers[n.Origin().Obj()]
}

// isRouter reports whether t is a router library's type or the repo's own.
func (a *routeAnalyzer) isRouter(t types.Type) bool {
	return isRouterType(t) || a.isWrapper(t)
}

// wrapperMethod reports whether f is a method of one of the repo's router types.
func (a *routeAnalyzer) wrapperMethod(f *types.Func) bool {
	r := f.Signature().Recv()
	return r != nil && a.isWrapper(r.Type())
}

var (
	wrapperAny     = set("Any", "All", "Handle", "HandleFunc")
	wrapperMethods = set("Methods", "Method", "Match", "Add")
	wrapperGroups  = set("Group", "Route", "Prefix", "Scope")
)

func firstParamString(sig *types.Signature) bool {
	if sig.Params().Len() == 0 {
		return false
	}
	b, ok := sig.Params().At(0).Type().Underlying().(*types.Basic)
	return ok && b.Info()&types.IsString != 0
}

// splitHandlers splits handler arguments into the endpoint (the last one) and
// the middleware before it.
func splitHandlers(args []ast.Expr) (handler, mw []ast.Expr) {
	if len(args) == 0 {
		return nil, nil
	}
	return args[len(args)-1:], args[:len(args)-1]
}

// wrapperEval is the router a wrapper method returns: a group, a route builder
// (Combo("/x") → its verb methods register at /x), or the same router.
func (a *routeAnalyzer) wrapperEval(call *ast.CallExpr, callee *types.Func, sc *rscope) *rnode {
	sig := callee.Signature()
	if sig.Results().Len() == 0 || !a.isRouter(sig.Results().At(0).Type()) {
		return nil
	}
	sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr)
	if !ok {
		return nil
	}
	recv := a.eval(sel.X, sc)
	if recv == nil {
		return nil
	}
	if firstParamString(sig) && verbOf(callee.Name()) == "" && len(call.Args) > 0 {
		p, ok := sc.stringValue(call.Args[0])
		if !ok {
			return nil
		}
		return recv.child(p, a.handlerIDs(a.notFuncLits(call.Args[1:]), sc))
	}
	if callee.Name() == "With" {
		return recv.child("", a.handlerIDs(call.Args, sc))
	}
	return recv // Get(h).Post(h) on a route builder, Use(…) returning itself
}

func (a *routeAnalyzer) notFuncLits(args []ast.Expr) []ast.Expr {
	var out []ast.Expr
	for _, x := range args {
		if _, ok := ast.Unparen(x).(*ast.FuncLit); !ok {
			out = append(out, x)
		}
	}
	return out
}

// wrapperCall handles a call of a wrapper method: registrations, groups,
// mounts and middleware.
func (a *routeAnalyzer) wrapperCall(call *ast.CallExpr, callee *types.Func, sc *rscope) {
	sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr)
	if !ok {
		return
	}
	recv := a.eval(sel.X, sc)
	if recv == nil {
		return
	}
	info := sc.p.TypesInfo
	name, args, sig := callee.Name(), call.Args, callee.Signature()
	path := firstParamString(sig)
	str := func(i int) (string, bool) {
		if i < len(args) {
			return sc.stringValue(args[i]) // a constant, or a local assigned once from one
		}
		return "", false
	}
	reg := func(method string, pathIdx int, rest []ast.Expr) {
		p := ""
		if pathIdx >= 0 {
			var ok bool
			if p, ok = str(pathIdx); !ok {
				return
			}
		}
		h, mw := splitHandlers(rest)
		if len(h) > 0 {
			a.register(call, sc, recv, method, p, h, mw)
		}
	}
	verb := verbOf(name)
	switch {
	case verb != "" && path && len(args) >= 2:
		reg(verb, 0, args[1:])
	case verb != "" && !path && len(args) >= 1:
		reg(verb, -1, args) // a route builder's verb: the path is the builder's
	case wrapperAny[name] && path && len(args) >= 2:
		reg("ANY", 0, args[1:])
	case wrapperMethods[name] && len(args) >= 3:
		methods := constStrings(info, args[0])
		if m, ok := str(0); ok {
			methods = strings.Split(m, ",")
		}
		for _, m := range methods {
			if m = strings.ToUpper(strings.TrimSpace(m)); m != "" {
				reg(m, 1, args[2:])
			}
		}
	case wrapperGroups[name] && sig.Results().Len() == 0:
		prefix, from := "", 0
		if path {
			p, ok := str(0)
			if !ok {
				return
			}
			prefix, from = p, 1
		}
		var cb ast.Expr
		var mw []ast.Expr
		for _, x := range args[min(from, len(args)):] {
			if _, ok := info.TypeOf(x).Underlying().(*types.Signature); ok && cb == nil && a.isCallback(x, info) {
				cb = x
			} else {
				mw = append(mw, x)
			}
		}
		if cb != nil {
			a.groupCallback(cb, sel.X, recv.child(prefix, a.handlerIDs(mw, sc)), sc)
		}
	case name == "Mount" && path && len(args) == 2:
		p, ok := str(0)
		if !ok {
			return
		}
		if child := a.eval(args[1], sc); child != nil && child.parent == nil && child != recv {
			child.parent, child.prefix, child.upto = recv, p, -1
			return
		}
		a.register(call, sc, recv, "ANY", strings.TrimSuffix(p, "/")+"/*", args[1:], nil)
	case name == "Use":
		recv.mw = append(recv.mw, a.handlerIDs(args, sc)...)
	}
}

// isCallback reports whether a group's function argument registers routes
// (takes no arguments, or a router) rather than being middleware.
func (a *routeAnalyzer) isCallback(x ast.Expr, info *types.Info) bool {
	sig, ok := info.TypeOf(x).Underlying().(*types.Signature)
	if !ok {
		return false
	}
	return sig.Params().Len() == 0 || sig.Params().Len() == 1 && a.isRouter(sig.Params().At(0).Type())
}

// groupCallback walks a group's callback with the group bound: to its router
// parameter, or, when it has none, to the router the group was called on
// (recvExpr), which the callback uses as a captured variable.
func (a *routeAnalyzer) groupCallback(arg, recvExpr ast.Expr, group *rnode, sc *rscope) {
	info := sc.p.TypesInfo
	if id, ok := ast.Unparen(arg).(*ast.Ident); ok {
		if x, ok := sc.exprs[info.Uses[id]]; ok {
			if lit, ok := ast.Unparen(x).(*ast.FuncLit); ok {
				arg = lit
			}
		}
	}
	lit, ok := ast.Unparen(arg).(*ast.FuncLit)
	if !ok || len(lit.Type.Params.List) > 0 {
		a.callback(arg, group, sc)
		return
	}
	a.handled[lit] = true
	a.litDone[lit] = true
	inner := a.newScope(sc.fnCtx, sc, lit.Body)
	var obj types.Object
	switch v := ast.Unparen(recvExpr).(type) {
	case *ast.Ident:
		obj = info.Uses[v]
	case *ast.SelectorExpr:
		if s, ok := info.Selections[v]; ok && s.Kind() == types.FieldVal {
			obj = s.Obj()
		} else {
			obj = info.Uses[v.Sel]
		}
	}
	if obj != nil {
		if isPackageLevel(obj) || obj.Parent() == nil { // package variable or field
			old, had := a.globals[obj]
			a.globals[obj] = group
			defer func() {
				if had {
					a.globals[obj] = old
				} else {
					delete(a.globals, obj)
				}
			}()
		} else {
			inner.vars[obj] = group
		}
	}
	a.walk(lit.Body, inner)
}
