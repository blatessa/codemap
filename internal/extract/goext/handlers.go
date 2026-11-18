package goext

import (
	"go/ast"
	"go/token"
	"go/types"
)

// handlerSet is what a handler expression resolves to.
type handlerSet struct {
	ids     []string // named functions, outermost first: middleware(handler) → [middleware, handler]
	callees []string // repo functions called by function literals in the expression
}

func (h *handlerSet) add(id string) {
	for _, x := range h.ids {
		if x == id {
			return
		}
	}
	h.ids = append(h.ids, id)
}

func (h *handlerSet) merge(o handlerSet) {
	for _, id := range o.ids {
		h.add(id)
	}
	h.callees = append(h.callees, o.callees...)
}

// last is the innermost named handler, or "".
func (h handlerSet) last() string {
	if len(h.ids) == 0 {
		return ""
	}
	return h.ids[len(h.ids)-1]
}

// all returns the named handlers followed by the literals' callees, without duplicates.
func (h handlerSet) all() []string {
	var out []string
	seen := map[string]bool{}
	for _, list := range [][]string{h.ids, h.callees} {
		for _, id := range list {
			if !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	return out
}

// resolveHandler resolves an expression passed as a handler or middleware to
// the functions it runs:
//   - h.Method (method value) and pkg.Func or Func (function value) → that function;
//   - http.HandlerFunc(x) and other conversions → x;
//   - mw(x), mw(cfg)(x), NewHandler(svc) → the called repo function, plus any
//     handler-like arguments, resolved the same way;
//   - a function literal → the repo functions it calls;
//   - a local variable → the expression last assigned to it.
//
// Method values on interface types and handlers stored in struct fields are not
// resolved.
func (l *load) resolveHandler(c *fnCtx, e ast.Expr, depth int) handlerSet {
	return l.resolveHandlerSkip(c, e, depth, nil)
}

// resolveHandlerSkip is resolveHandler leaving out what function literals call
// through the captured variables declared at the positions in skip.
func (l *load) resolveHandlerSkip(c *fnCtx, e ast.Expr, depth int, skip map[token.Pos]bool) handlerSet {
	var hs handlerSet
	if e == nil || depth > 6 {
		return hs
	}
	info := c.p.TypesInfo
	addFunc := func(f *types.Func) {
		if f == nil || f.Pkg() == nil || !l.isRepoPkg(f.Pkg().Path()) {
			return
		}
		if sig := f.Signature(); sig.Recv() != nil && types.IsInterface(sig.Recv().Type()) {
			return
		}
		if id := l.funcID(f); id != "" {
			hs.add(id)
		}
	}
	switch v := ast.Unparen(e).(type) {
	case *ast.FuncLit:
		hs.callees = l.closureCallees(v, c.p, skip)
	case *ast.Ident:
		switch obj := info.Uses[v].(type) {
		case *types.Func:
			addFunc(obj)
		case *types.Var:
			if x, ok := c.exprs[obj]; ok && x != e && handlerish(obj.Type()) {
				hs.merge(l.resolveHandlerSkip(c, x, depth+1, skip))
			}
		}
	case *ast.SelectorExpr:
		if s, ok := info.Selections[v]; ok {
			if s.Kind() == types.MethodVal {
				if f, ok := s.Obj().(*types.Func); ok && !types.IsInterface(s.Recv()) {
					addFunc(f)
				}
			}
		} else if f, ok := info.Uses[v.Sel].(*types.Func); ok {
			addFunc(f)
		}
	case *ast.CallExpr:
		if tv, ok := info.Types[v.Fun]; ok && tv.IsType() {
			if len(v.Args) == 1 {
				hs.merge(l.resolveHandlerSkip(c, v.Args[0], depth+1, skip))
			}
			return hs
		}
		if inner, ok := ast.Unparen(v.Fun).(*ast.CallExpr); ok {
			hs.merge(l.resolveHandlerSkip(c, inner, depth+1, skip)) // mw(cfg)(next)
		} else if f := staticCallee(info, v); f != nil {
			addFunc(f)
		}
		for _, a := range v.Args {
			if t := info.TypeOf(a); t != nil && handlerish(t) {
				hs.merge(l.resolveHandlerSkip(c, a, depth+1, skip))
			}
		}
	}
	return hs
}

// handlerish reports whether a value of type t could be a handler: a function,
// an interface, or something with a ServeHTTP method.
func handlerish(t types.Type) bool {
	switch t.Underlying().(type) {
	case *types.Signature, *types.Interface:
		return true
	}
	obj, _, _ := types.LookupFieldOrMethod(t, true, nil, "ServeHTTP")
	_, ok := obj.(*types.Func)
	return ok
}
