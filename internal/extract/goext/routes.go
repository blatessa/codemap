package goext

import (
	"fmt"
	"go/ast"
	"go/types"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/blatessa/codemap/internal/graph"
)

// Route detection. Supported: net/http ServeMux (Go 1.22
// patterns), chi, gorilla/mux, echo, gin, fiber, httprouter and go-pkgz/routegroup.
//
// Routers are tracked as a tree of rnodes: a router created by a constructor is
// a root; groups, sub-routers, With(…) chains and Route/Mount prefixes are
// children carrying a path prefix and middleware. Router values are followed
// through local variables, struct fields and package variables (all uses of a
// field share one router), function parameters (a function called with a router
// argument is analysed once per distinct router it receives), callbacks
// (chi Route/Group, fiber Route) and functions returning routers. Full paths
// and middleware chains are computed at the end, so Mount can attach a router
// after routes were registered on it.
//
// The repo's own router types are followed too (wrappers.go): a struct holding
// one of the routers above, or another such struct, is a router, and its
// methods are read by the conventions these frameworks share.
//
// Paths are string expressions over constants, local variables and the string
// parameters of route helpers (helpers.go), which are analysed per call site.
//
// Not handled: paths that depend on runtime values, routers passed through
// interfaces of the repo's own, gorilla's Methods(…).Subrouter(), and handlers
// stored in struct fields or reached through interface method values.

// framework returns the router framework an import path belongs to, or "".
func framework(pkgPath string) string {
	is := func(prefix string) bool {
		if pkgPath == prefix {
			return true
		}
		rest, ok := strings.CutPrefix(pkgPath, prefix+"/")
		return ok && majorVersion.MatchString(rest)
	}
	switch {
	case pkgPath == "net/http":
		return "nethttp"
	case is("github.com/go-chi/chi"):
		return "chi"
	case is("github.com/gorilla/mux"):
		return "gorilla"
	case is("github.com/labstack/echo"):
		return "echo"
	case is("github.com/gin-gonic/gin"):
		return "gin"
	case is("github.com/gofiber/fiber"):
		return "fiber"
	case is("github.com/julienschmidt/httprouter"):
		return "httprouter"
	case is("github.com/go-pkgz/routegroup"):
		return "routegroup"
	}
	return ""
}

var routerTypes = map[string]map[string]bool{
	"nethttp":    {"ServeMux": true},
	"chi":        {"Router": true, "Mux": true, "Routes": true},
	"gorilla":    {"Router": true},
	"echo":       {"Echo": true, "Group": true},
	"gin":        {"Engine": true, "RouterGroup": true, "IRouter": true, "IRoutes": true},
	"fiber":      {"App": true, "Router": true, "Group": true},
	"httprouter": {"Router": true},
	"routegroup": {"Bundle": true},
}

func isRouterType(t types.Type) bool {
	if t == nil {
		return false
	}
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	n, ok := t.(*types.Named)
	if !ok || n.Obj().Pkg() == nil {
		return false
	}
	return routerTypes[framework(n.Obj().Pkg().Path())][n.Obj().Name()]
}

// constructors that create a root router, per framework.
var routerConstructors = map[string]map[string]bool{
	"nethttp":    {"NewServeMux": true},
	"chi":        {"NewRouter": true, "NewMux": true},
	"gorilla":    {"NewRouter": true},
	"echo":       {"New": true},
	"gin":        {"New": true, "Default": true},
	"fiber":      {"New": true},
	"httprouter": {"New": true},
	"routegroup": {"New": true},
}

var httpVerbs = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"}

// verbOf returns the HTTP method a registration method name stands for: Get or
// GET → GET.
func verbOf(name string) string {
	u := strings.ToUpper(name)
	for _, v := range httpVerbs {
		if u == v {
			return v
		}
	}
	return ""
}

type rnode struct {
	parent *rnode
	prefix string
	mw     []string
	// upto is how much of the parent's middleware this node inherits: the
	// parent's len(mw) when the node was created, or -1 for all of it. Most
	// routers copy middleware when a group or route is created (gin, echo groups,
	// chi With/Group, fiber, routegroup); gorilla/mux and echo's root apply theirs
	// to every route whenever it was added, and chi's Mount inherits everything.
	upto int
	// global marks routers whose middleware applies to all their routes.
	global  bool
	gorilla bool // sub-routers of gorilla routers are global too
}

func newRoot(fw, typeName string) *rnode {
	return &rnode{global: fw == "gorilla" || fw == "echo" && typeName == "Echo", gorilla: fw == "gorilla"}
}

// rootFor returns a root router for a variable of type t.
func rootFor(t types.Type) *rnode {
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	if n, ok := t.(*types.Named); ok && n.Obj().Pkg() != nil {
		return newRoot(framework(n.Obj().Pkg().Path()), n.Obj().Name())
	}
	return &rnode{}
}

// child returns a group of r with the middleware r has now.
func (n *rnode) child(prefix string, mw []string) *rnode {
	return &rnode{parent: n, prefix: prefix, mw: mw, upto: n.snapshot(), global: n.gorilla, gorilla: n.gorilla}
}

// snapshot is the amount of n's middleware a group or route created now inherits.
func (n *rnode) snapshot() int {
	if n.global {
		return -1
	}
	return len(n.mw)
}

func (n *rnode) fullPrefix() string {
	if n == nil {
		return ""
	}
	return n.parent.fullPrefix() + n.prefix
}

// chain returns the middleware a route sees: the ancestors' inherited
// middleware followed by n's first k entries (all of them for k < 0).
func (n *rnode) chain(k int) []string {
	if n == nil {
		return nil
	}
	own := n.mw
	if k >= 0 && k < len(own) {
		own = own[:k]
	}
	return append(n.parent.chain(n.upto), own...)
}

type routeReg struct {
	node    *rnode
	upto    int // node.snapshot() at registration
	method  string
	path    string
	mw      []string
	handler []string
	module  string
	file    string
	line    int
}

type declRef struct {
	decl *ast.FuncDecl
	p    *packages.Package
}

type routeAnalyzer struct {
	l        *load
	wrappers map[*types.TypeName]bool // the repo's own router types
	local    map[*ast.FuncLit]*rscope // closures called or passed on: walked where they're used; → defining scope
	inLocal  map[*ast.FuncLit]bool
	litDone  map[*ast.FuncLit]bool // closures walked where they were used
	decls    map[*types.Func]declRef
	globals  map[types.Object]*rnode // struct fields and package variables
	memo     map[string]*rnode       // analysed function+context → returned router
	active   map[string]bool
	analysed map[*types.Func]bool
	fromCall map[*types.Func]bool // functions that receive a router or a path from a caller
	handled  map[ast.Node]bool    // callbacks and chained calls already processed
	routes   []routeReg
	defMux   *rnode
	helpers  map[*ast.BlockStmt]bool              // body → is a route helper
	litMemo  map[string]bool                      // helper closures walked, per bindings
	bodies   map[*fnCtx]ast.Node                  // analysed function → its body
	defs     map[ast.Node]map[types.Object]strDef // body → its local variables' assignments
}

// rscope is one function body being analysed.
type rscope struct {
	*fnCtx
	parent *rscope
	vars   map[types.Object]*rnode
	bound  map[types.Object]binding // parameters bound to strings and functions
	evals  map[ast.Expr]*rnode
	chainP map[ast.Expr]*ast.CallExpr // x → the call x.M(…) whose receiver it is
	ret    *rnode
}

func (s *rscope) lookup(obj types.Object) *rnode {
	for sc := s; sc != nil; sc = sc.parent {
		if n, ok := sc.vars[obj]; ok {
			return n
		}
	}
	return nil
}

func (l *load) addRoutes() {
	a := &routeAnalyzer{
		l: l, decls: map[*types.Func]declRef{}, globals: map[types.Object]*rnode{},
		memo: map[string]*rnode{}, active: map[string]bool{}, analysed: map[*types.Func]bool{},
		fromCall: map[*types.Func]bool{}, handled: map[ast.Node]bool{}, defMux: &rnode{},
		local: map[*ast.FuncLit]*rscope{}, inLocal: map[*ast.FuncLit]bool{}, litDone: map[*ast.FuncLit]bool{},
		helpers: map[*ast.BlockStmt]bool{}, litMemo: map[string]bool{}, bodies: map[*fnCtx]ast.Node{},
		defs: map[ast.Node]map[types.Object]strDef{},
	}
	a.wrappers = l.routerWrappers()
	var order []*types.Func
	for _, p := range l.plain {
		for _, f := range p.Syntax {
			rel, _ := l.pos(f.Pos())
			if rel == "" || l.fileExcluded(rel) {
				continue
			}
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				if obj, ok := p.TypesInfo.Defs[fd.Name].(*types.Func); ok {
					a.decls[obj] = declRef{fd, p}
					order = append(order, obj)
				}
			}
		}
	}
	// Functions that get their router, or a route path, from a caller are
	// analysed from there.
	for _, obj := range order {
		ref := a.decls[obj]
		info := ref.p.TypesInfo
		ast.Inspect(ref.decl.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			callee := staticCallee(info, call)
			if callee == nil {
				return true
			}
			if _, ok := a.decls[callee.Origin()]; ok {
				for _, arg := range call.Args {
					if a.isRouter(info.TypeOf(arg)) {
						a.fromCall[callee.Origin()] = true
					}
					if _, ok := constString(info, arg); ok && a.declHelper(callee) {
						a.fromCall[callee.Origin()] = true
					}
				}
			}
			if callee.Pkg() != nil && framework(callee.Pkg().Path()) != "" {
				for _, arg := range call.Args {
					if f := funcValue(info, arg); f != nil {
						a.fromCall[f.Origin()] = true
					}
				}
			}
			return true
		})
	}
	for _, obj := range order {
		if !a.fromCall[obj] {
			a.analyse(obj, nil)
		}
	}
	for _, obj := range order {
		if !a.analysed[obj] {
			a.analyse(obj, nil)
		}
	}
	a.emit()
}

// funcValue returns the function an expression refers to as a value (f, pkg.F, x.M).
func funcValue(info *types.Info, e ast.Expr) *types.Func {
	switch v := ast.Unparen(e).(type) {
	case *ast.Ident:
		f, _ := info.Uses[v].(*types.Func)
		return f
	case *ast.SelectorExpr:
		if s, ok := info.Selections[v]; ok {
			if s.Kind() == types.MethodVal {
				f, _ := s.Obj().(*types.Func)
				return f
			}
			return nil
		}
		f, _ := info.Uses[v.Sel].(*types.Func)
		return f
	}
	return nil
}

// analyse walks a function with some of its parameters bound (to routers, or
// for route helpers to constant strings and functions) and returns the router
// it returns, if any.
func (a *routeAnalyzer) analyse(obj *types.Func, params map[int]binding) *rnode {
	obj = obj.Origin()
	ref, ok := a.decls[obj]
	if !ok {
		return nil
	}
	key := obj.FullName() + argsKey(params)
	if r, ok := a.memo[key]; ok {
		return r
	}
	if a.active[key] || len(a.active) > 20 {
		return nil
	}
	a.active[key] = true
	defer delete(a.active, key)
	a.analysed[obj] = true

	fn := a.l.ssaFor(ref.decl, ref.p)
	if fn == nil {
		return nil
	}
	c := newFnCtx(ref.p, a.l.idOf(fn), a.l.moduleID(ref.p.PkgPath), obj, ref.decl.Type, ref.decl.Body)
	a.bodies[c] = ref.decl.Body
	sc := a.newScope(c, nil, ref.decl.Body)
	bindParams(ref.decl.Type, ref.p.TypesInfo, params, sc)
	a.walk(ref.decl.Body, sc)
	// closures passed somewhere that isn't a router: walk them where defined
	for lit, def := range a.local {
		if def == sc && !a.litDone[lit] {
			a.litDone[lit] = true
			a.walk(lit.Body, &rscope{fnCtx: sc.fnCtx, parent: sc, vars: map[types.Object]*rnode{}, evals: map[ast.Expr]*rnode{}, chainP: sc.chainP})
		}
	}
	a.memo[key] = sc.ret
	return sc.ret
}

func (a *routeAnalyzer) newScope(c *fnCtx, parent *rscope, body ast.Node) *rscope {
	sc := &rscope{fnCtx: c, parent: parent, vars: map[types.Object]*rnode{}, evals: map[ast.Expr]*rnode{}, chainP: map[ast.Expr]*ast.CallExpr{}}
	if parent != nil {
		// evals stays per scope: a callback walked twice (avatarRoutes passed to
		// two groups) must see its router parameter bound afresh each time.
		sc.chainP = parent.chainP
	}
	ast.Inspect(body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			if sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr); ok {
				sc.chainP[ast.Unparen(sel.X)] = call
			}
			// f() or g(…, f, …) with f := func() {…}
			uses := call.Args
			if len(call.Args) == 0 {
				uses = append(uses, call.Fun)
			}
			for _, u := range uses {
				if id, ok := ast.Unparen(u).(*ast.Ident); ok {
					if lit, ok := ast.Unparen(c.exprs[c.p.TypesInfo.Uses[id]]).(*ast.FuncLit); ok && len(lit.Type.Params.List) == 0 && a.local[lit] == nil {
						a.local[lit] = sc
					}
				}
			}
			// p("GET /x", h) with p := func(pattern string, …) {…}, a route helper
			if lit := a.localHelper(call, c); lit != nil && a.local[lit] == nil {
				a.local[lit] = sc
			}
		}
		return true
	})
	return sc
}

func (a *routeAnalyzer) walk(body ast.Node, sc *rscope) {
	info := sc.p.TypesInfo
	ast.Inspect(body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.FuncLit:
			// A literal taking a router is a callback (chi Route/Group): it's
			// walked when it's passed, with the router it receives. Other
			// literals are walked in a child scope, so their returns aren't
			// the function's.
			if !a.handled[s] && !a.takesRouter(s, info) && a.local[s] == nil {
				a.walk(s.Body, &rscope{fnCtx: sc.fnCtx, parent: sc, vars: map[types.Object]*rnode{}, evals: map[ast.Expr]*rnode{}, chainP: sc.chainP})
			}
			return false
		case *ast.RangeStmt:
			// for _, r := range []route{{"/a", a}, …} { mux.HandleFunc(r.path, r.h) }:
			// the body is walked once per element.
			if v, elems := a.rangeElems(s, sc); v != nil {
				for _, e := range elems {
					a.walk(s.Body, &rscope{fnCtx: sc.fnCtx, parent: sc, vars: map[types.Object]*rnode{}, evals: map[ast.Expr]*rnode{}, chainP: sc.chainP,
						bound: map[types.Object]binding{v: {elem: e}}})
				}
				return false
			}
		case *ast.AssignStmt:
			if len(s.Lhs) == len(s.Rhs) {
				for i, lhs := range s.Lhs {
					if r := a.eval(s.Rhs[i], sc); r != nil {
						a.bind(lhs, r, sc)
					}
				}
			}
		case *ast.ValueSpec:
			if len(s.Names) == len(s.Values) {
				for i, name := range s.Names {
					if r := a.eval(s.Values[i], sc); r != nil {
						if o := info.Defs[name]; o != nil {
							sc.vars[o] = r
						}
					}
				}
			}
		case *ast.ReturnStmt:
			if len(s.Results) > 0 && sc.ret == nil && sc.parent == nil {
				sc.ret = a.eval(s.Results[0], sc)
			}
		case *ast.CallExpr:
			a.call(s, sc)
			a.localCall(s, sc)
		}
		return true
	})
}

// localCall walks a closure held in a local variable where it's called, so
// the routes it registers get the group it's called in
// (addSettingsRoutes := func() { m.Group(…) }; m.Group("/settings", func() { addSettingsRoutes() })),
// or, for a route helper, the paths and handlers it's called with.
func (a *routeAnalyzer) localCall(call *ast.CallExpr, sc *rscope) {
	id, ok := ast.Unparen(call.Fun).(*ast.Ident)
	if !ok {
		return
	}
	info := sc.p.TypesInfo
	lit, ok := ast.Unparen(sc.exprs[info.Uses[id]]).(*ast.FuncLit)
	if !ok || a.local[lit] == nil || a.inLocal[lit] || len(a.inLocal) > 20 {
		return
	}
	inner := &rscope{fnCtx: sc.fnCtx, parent: sc, vars: map[types.Object]*rnode{}, evals: map[ast.Expr]*rnode{}, chainP: sc.chainP}
	if len(call.Args) > 0 {
		// A route helper: walked once per call site's bindings.
		sig, ok := info.TypeOf(lit).(*types.Signature)
		if !ok {
			return
		}
		params := a.callArgs(call, sig, sc, true)
		key := fmt.Sprintf("%p", lit) + argsKey(params)
		if a.litMemo[key] {
			return
		}
		a.litMemo[key] = true
		bindParams(lit.Type, info, params, inner)
	}
	a.litDone[lit] = true
	a.inLocal[lit] = true
	defer delete(a.inLocal, lit)
	a.walk(lit.Body, inner)
}

func (a *routeAnalyzer) bind(lhs ast.Expr, r *rnode, sc *rscope) {
	info := sc.p.TypesInfo
	switch v := ast.Unparen(lhs).(type) {
	case *ast.Ident:
		if o := objOf(info, v); o != nil {
			if isPackageLevel(o) {
				a.globals[o] = r
			} else {
				sc.vars[o] = r
			}
		}
	case *ast.SelectorExpr:
		if s, ok := info.Selections[v]; ok && s.Kind() == types.FieldVal {
			a.globals[s.Obj()] = r
		} else if o := info.Uses[v.Sel]; o != nil {
			a.globals[o] = r
		}
	}
}

func isPackageLevel(o types.Object) bool {
	return o.Pkg() != nil && o.Parent() == o.Pkg().Scope()
}

// eval returns the router an expression denotes, or nil.
func (a *routeAnalyzer) eval(e ast.Expr, sc *rscope) *rnode {
	e = ast.Unparen(e)
	if r, ok := sc.evals[e]; ok {
		return r
	}
	r := a.eval1(e, sc)
	sc.evals[e] = r
	return r
}

func (a *routeAnalyzer) eval1(e ast.Expr, sc *rscope) *rnode {
	info := sc.p.TypesInfo
	switch v := e.(type) {
	case *ast.StarExpr:
		return a.eval(v.X, sc)
	case *ast.UnaryExpr:
		return a.eval(v.X, sc)
	case *ast.Ident:
		o := info.Uses[v]
		if o == nil {
			return nil
		}
		if r := sc.lookup(o); r != nil {
			return r
		}
		if r := a.globals[o]; r != nil {
			return r
		}
		if _, ok := o.(*types.Var); ok && a.isRouter(o.Type()) {
			r := rootFor(o.Type())
			if isPackageLevel(o) {
				a.globals[o] = r
			} else {
				sc.vars[o] = r
			}
			return r
		}
	case *ast.SelectorExpr:
		var o types.Object
		if s, ok := info.Selections[v]; ok {
			if s.Kind() != types.FieldVal {
				return nil
			}
			o = s.Obj()
		} else {
			o = info.Uses[v.Sel]
		}
		if o == nil {
			return nil
		}
		if r := a.globals[o]; r != nil {
			return r
		}
		if _, ok := o.(*types.Var); ok && a.isRouter(o.Type()) {
			r := rootFor(o.Type())
			a.globals[o] = r
			return r
		}
	case *ast.CallExpr:
		return a.evalCall(v, sc)
	}
	return nil
}

func (a *routeAnalyzer) evalCall(call *ast.CallExpr, sc *rscope) *rnode {
	info := sc.p.TypesInfo
	callee := staticCallee(info, call)
	if callee == nil {
		return nil
	}
	fw := ""
	if callee.Pkg() != nil {
		fw = framework(callee.Pkg().Path())
	}
	if fw == "" {
		if a.wrapperMethod(callee) {
			return a.wrapperEval(call, callee, sc)
		}
		if _, ok := a.decls[callee.Origin()]; ok && a.returnsRouter(callee) {
			if r := a.analyse(callee, a.callArgs(call, callee.Signature(), sc, a.declHelper(callee))); r != nil {
				return r
			}
			if a.isWrapper(callee.Signature().Results().At(0).Type()) {
				return &rnode{} // a constructor of the repo's router: a new root
			}
		}
		return nil
	}
	name := callee.Name()
	if callee.Signature().Recv() == nil {
		if routerConstructors[fw][name] {
			r := newRoot(fw, "")
			if res := callee.Signature().Results(); res.Len() > 0 {
				r = rootFor(res.At(0).Type())
			}
			return r
		}
		if fw == "routegroup" && name == "Mount" && len(call.Args) == 2 {
			p, _ := constString(info, call.Args[1])
			return &rnode{prefix: p}
		}
		return nil
	}
	sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr)
	if !ok {
		return nil
	}
	if fw == "gorilla" && name == "Subrouter" {
		return a.gorillaSubrouter(sel.X, sc)
	}
	recv := a.eval(sel.X, sc)
	if recv == nil {
		return nil
	}
	str := func(i int) string {
		if i < len(call.Args) {
			s, _ := a.str(call.Args[i], sc)
			return s
		}
		return ""
	}
	switch {
	case fw == "chi" && name == "With":
		return recv.child("", a.handlerIDs(call.Args, sc))
	case fw == "routegroup" && name == "Mount":
		return recv.child(str(0), nil)
	case fw == "routegroup" && name == "Group":
		return recv.child("", nil)
	case fw == "routegroup" && name == "With":
		return recv.child("", a.handlerIDs(call.Args, sc))
	case fw == "chi" && name == "Group":
		return recv.child("", nil)
	case (fw == "chi" || fw == "fiber") && name == "Route":
		return recv.child(str(0), nil)
	case (fw == "echo" || fw == "gin" || fw == "fiber") && name == "Group":
		var mw []string
		if len(call.Args) > 1 {
			mw = a.handlerIDs(call.Args[1:], sc)
		}
		return recv.child(str(0), mw)
	}
	if sig := callee.Signature(); sig.Results().Len() == 1 && a.isRouter(sig.Results().At(0).Type()) {
		return recv // methods that return the same router, like gin's Use
	}
	return nil
}

// takesRouter reports whether a function literal has a router parameter.
func (a *routeAnalyzer) takesRouter(lit *ast.FuncLit, info *types.Info) bool {
	for _, f := range lit.Type.Params.List {
		if a.isRouter(info.TypeOf(f.Type)) {
			return true
		}
	}
	return false
}

func (a *routeAnalyzer) returnsRouter(f *types.Func) bool {
	r := f.Signature().Results()
	return r.Len() >= 1 && a.isRouter(r.At(0).Type())
}

// gorillaSubrouter handles r.PathPrefix("/x").Subrouter() (and Host/Schemes/…
// in the chain).
func (a *routeAnalyzer) gorillaSubrouter(x ast.Expr, sc *rscope) *rnode {
	info := sc.p.TypesInfo
	prefix := ""
	for {
		call, ok := ast.Unparen(x).(*ast.CallExpr)
		if !ok {
			break
		}
		sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr)
		callee := staticCallee(info, call)
		if !ok || callee == nil || callee.Signature().Recv() == nil || framework(callee.Pkg().Path()) != "gorilla" {
			break
		}
		if isRouterType(info.TypeOf(sel.X)) {
			if callee.Name() == "PathPrefix" && len(call.Args) == 1 {
				p, _ := constString(info, call.Args[0])
				prefix = p + prefix
			}
			if parent := a.eval(sel.X, sc); parent != nil {
				return parent.child(prefix, nil)
			}
			return nil
		}
		if callee.Name() == "PathPrefix" && len(call.Args) == 1 {
			p, _ := constString(info, call.Args[0])
			prefix = p + prefix
		}
		x = sel.X
	}
	return nil
}

func (a *routeAnalyzer) handlerIDs(args []ast.Expr, sc *rscope) []string {
	var hs handlerSet
	for _, arg := range args {
		hs.merge(a.resolveIn(arg, sc, 0))
	}
	return hs.all()
}

// callback analyses a function passed to chi's Route/Group (or fiber's Route)
// with its router parameter bound to r.
func (a *routeAnalyzer) callback(arg ast.Expr, r *rnode, sc *rscope) {
	info := sc.p.TypesInfo
	if id, ok := ast.Unparen(arg).(*ast.Ident); ok {
		if x, ok := sc.exprs[info.Uses[id]]; ok {
			if lit, ok := ast.Unparen(x).(*ast.FuncLit); ok {
				arg = lit // routes := func(r chi.Router) {…}; r.Group(routes)
			}
		}
	}
	if lit, ok := ast.Unparen(arg).(*ast.FuncLit); ok {
		a.handled[lit] = true
		a.litDone[lit] = true
		inner := a.newScope(sc.fnCtx, sc, lit.Body)
		if ps := lit.Type.Params.List; len(ps) > 0 && len(ps[0].Names) > 0 {
			if o := info.Defs[ps[0].Names[0]]; o != nil {
				inner.vars[o] = r
			}
		}
		a.walk(lit.Body, inner)
		return
	}
	if f := funcValue(info, arg); f != nil {
		a.analyse(f, map[int]binding{0: {r: r}})
	}
}

// call handles route registrations, middleware, mounts and calls passing routers on.
func (a *routeAnalyzer) call(call *ast.CallExpr, sc *rscope) {
	if a.handled[call] {
		return
	}
	info := sc.p.TypesInfo
	callee := staticCallee(info, call)
	if callee == nil {
		return
	}
	fw := ""
	if callee.Pkg() != nil {
		fw = framework(callee.Pkg().Path())
	}
	if fw == "" {
		if a.wrapperMethod(callee) {
			a.wrapperCall(call, callee, sc)
			return
		}
		if _, ok := a.decls[callee.Origin()]; ok {
			helper := a.declHelper(callee)
			if ps := a.callArgs(call, callee.Signature(), sc, helper); hasRouter(ps) || helper && hasStr(ps) {
				a.analyse(callee, ps)
			}
		}
		return
	}
	name := callee.Name()
	args := call.Args
	str := func(i int) (string, bool) {
		if i < len(args) {
			return a.str(args[i], sc)
		}
		return "", false
	}
	var recv *rnode
	if callee.Signature().Recv() != nil {
		sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr)
		if !ok {
			return
		}
		if fw == "gorilla" && !isRouterType(info.TypeOf(sel.X)) {
			a.gorillaRouteCall(call, callee, sc)
			return
		}
		recv = a.eval(sel.X, sc)
		if recv == nil {
			return
		}
	} else if fw == "nethttp" && (name == "Handle" || name == "HandleFunc") {
		recv = a.defMux
	} else {
		return
	}

	reg := func(method string, pathIdx int, handler []ast.Expr, mw []ast.Expr) {
		p, ok := str(pathIdx)
		if !ok {
			return
		}
		a.register(call, sc, recv, method, p, handler, mw)
	}
	verb := verbOf(name)
	switch fw {
	case "nethttp":
		if (name == "Handle" || name == "HandleFunc") && len(args) == 2 {
			pat, ok := str(0)
			if !ok {
				return
			}
			method, p := splitServeMuxPattern(pat)
			a.register(call, sc, recv, method, p, args[1:], nil)
		}
	case "chi":
		switch {
		case verb != "" && len(args) == 2:
			reg(verb, 0, args[1:], nil)
		case (name == "Handle" || name == "HandleFunc") && len(args) == 2:
			reg("ANY", 0, args[1:], nil)
		case (name == "Method" || name == "MethodFunc") && len(args) == 3:
			if m, ok := str(0); ok {
				reg(strings.ToUpper(m), 1, args[2:], nil)
			}
		case name == "Mount" && len(args) == 2:
			p, ok := str(0)
			if !ok {
				return
			}
			if child := a.eval(args[1], sc); child != nil && child.parent == nil && child != recv {
				child.parent, child.prefix, child.upto = recv, p, -1
				return
			}
			a.register(call, sc, recv, "ANY", strings.TrimSuffix(p, "/")+"/*", args[1:], nil)
		case name == "Route" && len(args) == 2:
			a.callback(args[1], a.eval(call, sc), sc)
		case name == "Group" && len(args) == 1:
			a.callback(args[0], a.eval(call, sc), sc)
		case name == "Use":
			recv.mw = append(recv.mw, a.handlerIDs(args, sc)...)
		}
	case "echo":
		switch {
		case verb != "" && len(args) >= 2:
			reg(verb, 0, args[1:2], args[2:])
		case name == "Any" && len(args) >= 2:
			reg("ANY", 0, args[1:2], args[2:])
		case name == "Add" && len(args) >= 3:
			if m, ok := str(0); ok {
				reg(strings.ToUpper(m), 1, args[2:3], args[3:])
			}
		case name == "Match" && len(args) >= 3:
			for _, m := range constStrings(info, args[0]) {
				reg(strings.ToUpper(m), 1, args[2:3], args[3:])
			}
		case name == "Use" || name == "Pre":
			recv.mw = append(recv.mw, a.handlerIDs(args, sc)...)
		}
	case "gin", "fiber":
		last := func(from int) ([]ast.Expr, []ast.Expr) {
			if len(args) <= from {
				return nil, nil
			}
			return args[len(args)-1:], args[from : len(args)-1]
		}
		switch {
		case verb != "" && len(args) >= 2:
			h, mw := last(1)
			reg(verb, 0, h, mw)
		case (name == "Any" || name == "All") && len(args) >= 2:
			h, mw := last(1)
			reg("ANY", 0, h, mw)
		case (name == "Handle" || name == "Add") && len(args) >= 3:
			h, mw := last(2)
			methods := constStrings(info, args[0])
			if m, ok := str(0); ok {
				methods = []string{m}
			}
			for _, m := range methods {
				reg(strings.ToUpper(m), 1, h, mw)
			}
		case name == "Match" && len(args) >= 3:
			h, mw := last(2)
			for _, m := range constStrings(info, args[0]) {
				reg(strings.ToUpper(m), 1, h, mw)
			}
		case fw == "fiber" && name == "Route" && len(args) >= 2:
			a.callback(args[1], a.eval(call, sc), sc)
		case name == "Use":
			var mws []ast.Expr
			for _, arg := range args {
				if !isString(info, arg) {
					mws = append(mws, arg)
				}
			}
			recv.mw = append(recv.mw, a.handlerIDs(mws, sc)...)
		}
	case "routegroup":
		switch {
		case (name == "Handle" || name == "HandleFunc") && len(args) == 2:
			pat, ok := str(0)
			if !ok {
				return
			}
			method, p := splitServeMuxPattern(pat)
			a.register(call, sc, recv, method, p, args[1:], nil)
		case (name == "HandleRoot" || name == "HandleRootFunc") && len(args) == 2:
			if m, ok := str(0); ok {
				a.register(call, sc, recv, strings.ToUpper(m), "", args[1:], nil)
			}
		case name == "Route" && len(args) == 1:
			// Route configures a new group when called on the root bundle; treating
			// it as a group everywhere keeps its middleware off sibling routes.
			a.callback(args[0], recv.child("", nil), sc)
		case name == "Use":
			recv.mw = append(recv.mw, a.handlerIDs(args, sc)...)
		}
	case "httprouter":
		switch {
		case verb != "" && len(args) == 2:
			reg(verb, 0, args[1:], nil)
		case (name == "Handle" || name == "HandlerFunc" || name == "Handler") && len(args) == 3:
			if m, ok := str(0); ok {
				reg(strings.ToUpper(m), 1, args[2:], nil)
			}
		}
	case "gorilla":
		switch {
		case (name == "HandleFunc" || name == "Handle") && len(args) == 2:
			methods := a.gorillaMethods(call, sc)
			for _, m := range methods {
				reg(m, 0, args[1:], nil)
			}
		case name == "Use":
			recv.mw = append(recv.mw, a.handlerIDs(args, sc)...)
		}
	}
}

// gorillaMethods returns the methods set by .Methods(…) calls chained onto a
// gorilla registration, or ["ANY"].
func (a *routeAnalyzer) gorillaMethods(call *ast.CallExpr, sc *rscope) []string {
	info := sc.p.TypesInfo
	var methods []string
	for p := sc.chainP[call]; p != nil; p = sc.chainP[p] {
		f := staticCallee(info, p)
		if f == nil || f.Pkg() == nil || framework(f.Pkg().Path()) != "gorilla" {
			break
		}
		if f.Name() == "Methods" {
			for _, arg := range p.Args {
				methods = append(methods, constStrings(info, arg)...)
			}
		}
	}
	if len(methods) == 0 {
		return []string{"ANY"}
	}
	for i := range methods {
		methods[i] = strings.ToUpper(methods[i])
	}
	return methods
}

// gorillaRouteCall handles r.Path("/x").Methods("GET").HandlerFunc(h) and
// r.PathPrefix("/static/").Handler(h): a Handler/HandlerFunc call at the end of
// a *mux.Route chain that starts at a router.
func (a *routeAnalyzer) gorillaRouteCall(call *ast.CallExpr, callee *types.Func, sc *rscope) {
	if callee.Name() != "Handler" && callee.Name() != "HandlerFunc" || len(call.Args) != 1 {
		return
	}
	info := sc.p.TypesInfo
	path, prefix := "", false
	var methods []string
	x := ast.Unparen(call.Fun).(*ast.SelectorExpr).X
	for {
		c, ok := ast.Unparen(x).(*ast.CallExpr)
		if !ok {
			return
		}
		sel, ok := ast.Unparen(c.Fun).(*ast.SelectorExpr)
		f := staticCallee(info, c)
		if !ok || f == nil || f.Pkg() == nil || framework(f.Pkg().Path()) != "gorilla" {
			return
		}
		switch f.Name() {
		case "Path", "PathPrefix":
			if len(c.Args) == 1 {
				if p, ok := constString(info, c.Args[0]); ok {
					path, prefix = p, f.Name() == "PathPrefix"
				}
			}
		case "Methods":
			for _, arg := range c.Args {
				methods = append(methods, constStrings(info, arg)...)
			}
		}
		if isRouterType(info.TypeOf(sel.X)) {
			recv := a.eval(sel.X, sc)
			if recv == nil || path == "" {
				return
			}
			if prefix {
				path = strings.TrimSuffix(path, "/") + "/*"
			}
			if len(methods) == 0 {
				methods = []string{"ANY"}
			}
			for _, m := range methods {
				a.register(call, sc, recv, strings.ToUpper(m), path, call.Args, nil)
			}
			return
		}
		x = sel.X
	}
}

// constStrings returns the constant strings in e: a constant, or a slice
// literal of constants ([]string{"GET", "POST"}).
func constStrings(info *types.Info, e ast.Expr) []string {
	if s, ok := constString(info, e); ok {
		return []string{s}
	}
	var out []string
	if cl, ok := ast.Unparen(e).(*ast.CompositeLit); ok {
		for _, el := range cl.Elts {
			if s, ok := constString(info, el); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

// splitServeMuxPattern splits a Go 1.22 ServeMux pattern "[METHOD ][HOST]/[PATH]".
func splitServeMuxPattern(pat string) (method, path string) {
	method = "ANY"
	if m, rest, ok := strings.Cut(pat, " "); ok && !strings.Contains(m, "/") {
		method, pat = strings.ToUpper(m), strings.TrimLeft(rest, " \t")
	}
	if i := strings.IndexByte(pat, '/'); i > 0 {
		pat = pat[i:] // drop host
	}
	pat = strings.TrimSuffix(pat, "{$}")
	return method, pat
}

func (a *routeAnalyzer) register(call *ast.CallExpr, sc *rscope, r *rnode, method, path string, handler, mw []ast.Expr) {
	file, line := a.l.pos(call.Pos())
	a.routes = append(a.routes, routeReg{
		node: r, upto: r.snapshot(), method: method, path: path,
		mw: a.handlerIDs(mw, sc), handler: a.handlerIDs(handler, sc),
		module: sc.mod, file: file, line: line,
	})
}

func (a *routeAnalyzer) emit() {
	b := a.l.x.b
	for _, rt := range a.routes {
		full := graph.NormalizeRoutePath(rt.node.fullPrefix() + "/" + strings.TrimPrefix(rt.path, "/"))
		id := graph.RouteID(rt.method, full)
		b.addNode(graph.Node{
			ID: id, Kind: graph.KindRoute, Label: full, Module: rt.module, File: rt.file, Line: rt.line,
			Entry: true, Fields: map[string]any{"method": rt.method},
		})
		for _, list := range [][]string{rt.node.chain(rt.upto), rt.mw, rt.handler} {
			for _, to := range list {
				b.addEdge(graph.Edge{From: id, To: to, Type: graph.Calls, File: rt.file, Line: rt.line})
			}
		}
	}
}
