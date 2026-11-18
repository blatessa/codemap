package goext

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"net/url"
	"os"
	"slices"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/blatessa/codemap/internal/extract/sqlext"
	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// DefaultDBMethods are the method names whose first constant string argument
// is treated as SQL. They cover database/sql, pgx, sqlx and sqlc-generated code;
// config.go.db_methods adds to them. Any receiver type matches, so a repo's own
// Query/Exec wrappers count too; the classifier ignores strings that aren't SQL.
var DefaultDBMethods = []string{
	"Query", "QueryRow", "Exec", "QueryContext", "QueryRowContext", "ExecContext",
	"Get", "GetContext", "Select", "SelectContext", "NamedExec", "NamedExecContext",
	"NamedQuery", "NamedQueryContext", "Queryx", "QueryRowx", "QueryxContext", "QueryRowxContext",
	"MustExec", "MustExecContext", "Prepare", "PrepareContext", "Preparex", "PreparexContext",
	"Raw", "Queue", "SQL",
}

// fnCtx is the function whose body is being scanned.
type fnCtx struct {
	p      *packages.Package
	id     string // node ID calls are attributed to
	mod    string
	fn     *types.Func               // the declared function; nil for closures in package vars
	exprs  map[types.Object]ast.Expr // local variable → last assigned expression
	consts map[types.Object]string   // local variables assigned exactly once, from a constant string
	params map[types.Object]int      // parameter → index
	body   ast.Node
	rl     *reqLocals // computed on first use (requests.go)
}

func newFnCtx(p *packages.Package, id, mod string, fn *types.Func, ftype *ast.FuncType, body ast.Node) *fnCtx {
	c := &fnCtx{p: p, id: id, mod: mod, fn: fn, params: map[types.Object]int{}, body: body}
	c.exprs, c.consts = localExprs(body, p.TypesInfo)
	i := 0
	for _, f := range ftype.Params.List {
		if len(f.Names) == 0 {
			i++
		}
		for _, n := range f.Names {
			if o := p.TypesInfo.Defs[n]; o != nil {
				c.params[o] = i
			}
			i++
		}
	}
	return c
}

// stringValue returns e's value if it's a constant string or a local variable
// assigned once from one (query := `SELECT …`).
func (c *fnCtx) stringValue(e ast.Expr) (string, bool) {
	if s, ok := constString(c.p.TypesInfo, e); ok {
		return s, true
	}
	if id, ok := ast.Unparen(e).(*ast.Ident); ok {
		s, ok := c.consts[c.p.TypesInfo.Uses[id]]
		return s, ok
	}
	return "", false
}

// paramIndex returns the parameter index e refers to, or -1.
func (c *fnCtx) paramIndex(e ast.Expr) int {
	if id, ok := ast.Unparen(e).(*ast.Ident); ok {
		if i, ok := c.params[c.p.TypesInfo.Uses[id]]; ok {
			return i
		}
	}
	return -1
}

// eachFunc calls f for every function body in the repo's non-test code, with
// the node its code belongs to.
func (l *load) eachFunc(f func(c *fnCtx, body ast.Node)) {
	for _, p := range l.plain {
		mod := l.moduleID(p.PkgPath)
		for _, file := range p.Syntax {
			rel, _ := l.pos(file.Pos())
			if rel == "" || l.fileExcluded(rel) {
				continue
			}
			for _, d := range file.Decls {
				switch d := d.(type) {
				case *ast.FuncDecl:
					if d.Body == nil {
						continue
					}
					fn := l.ssaFor(d, p)
					if fn == nil {
						continue
					}
					obj, _ := p.TypesInfo.Defs[d.Name].(*types.Func)
					f(newFnCtx(p, l.idOf(fn), mod, obj, d.Type, d.Body), d.Body)
				case *ast.GenDecl:
					for _, s := range d.Specs {
						vs, ok := s.(*ast.ValueSpec)
						if !ok {
							continue
						}
						for _, v := range vs.Values {
							if lit := funcLit(v); lit != nil {
								if fn := l.ssaFor(lit, p); fn != nil && l.varClosures[fn] != "" {
									f(newFnCtx(p, l.varClosures[fn], mod, nil, lit.Type, lit.Body), lit.Body)
								}
							}
						}
					}
				}
			}
		}
	}
}

// localExprs maps each local variable to the last expression assigned to it,
// and each variable assigned exactly once from a constant string to its value.
func localExprs(body ast.Node, info *types.Info) (map[types.Object]ast.Expr, map[types.Object]string) {
	m := map[types.Object]ast.Expr{}
	count := map[types.Object]int{}
	assign := func(id *ast.Ident, e ast.Expr) {
		if obj := objOf(info, id); obj != nil {
			count[obj]++
			if e != nil {
				m[obj] = e
			}
		}
	}
	ast.Inspect(body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			for i, lhs := range s.Lhs {
				id, ok := lhs.(*ast.Ident)
				if !ok {
					continue
				}
				var rhs ast.Expr
				if len(s.Lhs) == len(s.Rhs) && (s.Tok == token.DEFINE || s.Tok == token.ASSIGN) {
					rhs = s.Rhs[i]
				}
				assign(id, rhs)
			}
		case *ast.ValueSpec:
			for i, id := range s.Names {
				var v ast.Expr
				if len(s.Names) == len(s.Values) {
					v = s.Values[i]
				}
				assign(id, v)
			}
		case *ast.UnaryExpr:
			if s.Op == token.AND { // &x: may be changed elsewhere
				if id, ok := s.X.(*ast.Ident); ok {
					assign(id, nil)
				}
			}
		}
		return true
	})
	consts := map[types.Object]string{}
	for obj, e := range m {
		if count[obj] == 1 {
			if v, ok := constString(info, e); ok {
				consts[obj] = v
			}
		}
	}
	return m, consts
}

func objOf(info *types.Info, id *ast.Ident) types.Object {
	if o := info.Defs[id]; o != nil {
		return o
	}
	return info.Uses[id]
}

// staticCallee returns the function or method a call names, or nil for calls
// of function values, conversions and builtins.
func staticCallee(info *types.Info, call *ast.CallExpr) *types.Func {
	fun := ast.Unparen(call.Fun)
	if ix, ok := fun.(*ast.IndexExpr); ok {
		fun = ix.X
	} else if ix, ok := fun.(*ast.IndexListExpr); ok {
		fun = ix.X
	}
	var id *ast.Ident
	switch f := fun.(type) {
	case *ast.Ident:
		id = f
	case *ast.SelectorExpr:
		id = f.Sel
	default:
		return nil
	}
	fn, _ := info.Uses[id].(*types.Func)
	return fn
}

// constString returns e's value if it's a constant string.
func constString(info *types.Info, e ast.Expr) (string, bool) {
	tv, ok := info.Types[e]
	if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
		return "", false
	}
	return constant.StringVal(tv.Value), true
}

func isString(info *types.Info, e ast.Expr) bool {
	t := info.TypeOf(e)
	if t == nil {
		return false
	}
	b, ok := t.Underlying().(*types.Basic)
	return ok && b.Info()&types.IsString != 0
}

// source returns the source text of a node.
func (l *load) source(n ast.Node) string {
	start, end := l.fset.Position(n.Pos()), l.fset.Position(n.End())
	data := l.fileData(start.Filename)
	if data == nil || start.Offset > len(data) || end.Offset > len(data) || start.Offset > end.Offset {
		return ""
	}
	return string(data[start.Offset:end.Offset])
}

func (l *load) fileData(name string) []byte {
	if d, ok := l.files[name]; ok {
		return d
	}
	d, _ := os.ReadFile(name)
	l.files[name] = d
	return d
}

// scanCalls finds SQL queries, ORM calls (orm.go), SQL assembled from fragments (fragments.go), calls to external services and configured
// job/subscriber/publisher calls in every function body.
func (l *load) scanCalls() {
	dbMethods := map[string]bool{}
	for _, m := range DefaultDBMethods {
		dbMethods[m] = true
	}
	for _, m := range l.x.cfg.Go.DBMethods {
		dbMethods[m] = true
	}
	l.eachFunc(func(c *fnCtx, body ast.Node) {
		if !l.x.b.has(c.id) {
			return
		}
		info := c.p.TypesInfo
		orm := map[*ast.CallExpr]bool{}
		ast.Inspect(body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			file, line := l.pos(call.Pos())
			l.ormCall(c, call, orm, file, line)
			callee := staticCallee(info, call)
			if sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr); ok && dbMethods[sel.Sel.Name] {
				if s, ok := info.Selections[sel]; ok && s.Kind() == types.MethodVal {
					l.sqlCall(c, call, file, line)
				}
			}
			if callee != nil && callee.Pkg() != nil {
				l.extCall(c, call, callee, file, line)
			}
			l.patternCalls(c, call, callee, file, line)
			return true
		})
	})
	l.queryWrappers()
	l.reqWrapperCalls()
	l.ormWrappers()
	l.ormLocalAccesses()
	l.scanFragments()
}

// queryWrappers follows queries passed through the repo's own helpers: when a
// function hands one of its parameters to a DB method (fetch(ctx, query, args…)
// calling db.QueryContext(ctx, query, args…)), a constant passed for that
// parameter counts as a query of the caller. Chains of helpers are followed a
// few levels deep.
func (l *load) queryWrappers() {
	done := map[*types.Func]bool{}
	for round := 0; round < 4; round++ {
		var todo []*types.Func
		for f := range l.queryParams {
			if !done[f] {
				todo = append(todo, f)
				done[f] = true
			}
		}
		if len(todo) == 0 {
			return
		}
		l.eachFunc(func(c *fnCtx, body ast.Node) {
			if !l.x.b.has(c.id) {
				return
			}
			ast.Inspect(body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				callee := staticCallee(c.p.TypesInfo, call)
				if callee == nil {
					return true
				}
				f := callee.Origin()
				idx, ok := l.queryParams[f]
				if !ok || !slices.Contains(todo, f) || idx >= len(call.Args) {
					return true
				}
				file, line := l.pos(call.Pos())
				l.query(c, call.Args[idx], file, line)
				return true
			})
		})
	}
}

func (l *load) sqlCall(c *fnCtx, call *ast.CallExpr, file string, line int) {
	for _, a := range call.Args {
		if isString(c.p.TypesInfo, a) {
			l.query(c, a, file, line)
			return
		}
	}
}

// query adds edges for a query argument if it's constant. If it's a parameter
// of the enclosing function, that function is recorded as a query wrapper.
func (l *load) query(c *fnCtx, arg ast.Expr, file string, line int) {
	q, ok := c.stringValue(arg)
	if !ok {
		if i := c.paramIndex(arg); i >= 0 && c.fn != nil {
			if _, seen := l.queryParams[c.fn]; !seen {
				l.queryParams[c.fn] = i
			}
		}
		return // not a constant: don't guess
	}
	l.sqlSeen[sqlKey{c.id, q}] = true
	detail := sqlext.Collapse(q)
	for _, acc := range sqlext.Classify(q) {
		id := sqlext.TableID(acc.Table)
		l.ensureTable(id, acc.Table)
		typ := graph.Reads
		if acc.Write {
			typ = graph.Writes
		}
		l.x.b.addEdge(graph.Edge{From: c.id, To: id, Type: typ, Detail: detail, File: file, Line: line})
	}
}

// ensureTable adds a table node for a table that no migration defines.
func (l *load) ensureTable(id, name string) { l.x.ensureTable(id, name) }

func (x *extractor) ensureTable(id, name string) {
	if x.b.has(id) {
		return
	}
	if _, ok := x.b.modules[sqlext.DatabaseModule]; !ok {
		x.b.addModule(sqlext.DatabaseModuleFor(nil))
	}
	x.b.addNode(graph.Node{ID: id, Kind: graph.KindTable, Label: name, Module: sqlext.DatabaseModule, External: true})
}

func (l *load) ensureService(id, label string, fields map[string]any) {
	if l.x.b.has(id) {
		return
	}
	l.x.b.addModule(graph.Module{ID: servicesModule, Label: "external services", External: true})
	l.x.b.addNode(graph.Node{ID: id, Kind: graph.KindService, Label: label, Module: servicesModule, External: true, Fields: fields})
}

// isRepoPkg reports whether an import path belongs to one of the repo's modules.
func (l *load) isRepoPkg(path string) bool {
	for _, m := range l.x.modulePaths {
		if path == m || strings.HasPrefix(path, m+"/") {
			return true
		}
	}
	return false
}

// extCall adds an edge for a call into a known external-service SDK, or an
// HTTP request to a constant URL.
func (l *load) extCall(c *fnCtx, call *ast.CallExpr, callee *types.Func, file string, line int) {
	pkgPath := callee.Pkg().Path()
	if pkgPath == "net/http" {
		l.httpRequest(c, call, callee, file, line)
		l.httpCall(c, call, callee, file, line)
		return
	}
	if l.isRepoPkg(pkgPath) {
		return
	}
	m, ok := l.x.ext.lookup(pkgPath)
	if !ok || isPointerHelper(callee) {
		return
	}
	imp := m.root
	if p := l.pkgByTypes[callee.Pkg()]; p != nil && p.Module != nil && strings.HasPrefix(m.root, p.Module.Path) {
		imp = p.Module.Path
	}
	l.ensureService(m.id, m.label, map[string]any{"import": imp})
	l.x.b.addEdge(graph.Edge{From: c.id, To: m.id, Type: graph.Calls, Detail: l.extDetail(c, call, callee, m.root), File: file, Line: line})
}

// extDetail names the SDK call: "PaymentIntents.New" for a method reached
// through fields of SDK types, "client.New" for a function in a subpackage of
// the SDK, "NewClient" for one at its root.
func (l *load) extDetail(c *fnCtx, call *ast.CallExpr, callee *types.Func, root string) string {
	info := c.p.TypesInfo
	if callee.Signature().Recv() == nil {
		if callee.Pkg().Path() == root {
			return callee.Name()
		}
		return callee.Pkg().Name() + "." + callee.Name()
	}
	parts := []string{callee.Name()}
	if sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr); ok {
		x := ast.Unparen(sel.X)
		for {
			fs, ok := x.(*ast.SelectorExpr)
			if !ok {
				break
			}
			s, ok := info.Selections[fs]
			if !ok || s.Kind() != types.FieldVal || s.Obj().Pkg() == nil || l.isRepoPkg(s.Obj().Pkg().Path()) {
				break
			}
			parts = append([]string{fs.Sel.Name}, parts...)
			x = ast.Unparen(fs.X)
		}
	}
	return strings.Join(parts, ".")
}

// httpCall turns http.Get/Post/NewRequest with a constant URL into an edge to
// ext:<host>, with the method and path as detail.
func (l *load) httpCall(c *fnCtx, call *ast.CallExpr, callee *types.Func, file string, line int) {
	if callee.Signature().Recv() != nil {
		return
	}
	info := c.p.TypesInfo
	method, urlArg := "", -1
	switch callee.Name() {
	case "Get", "Head":
		method, urlArg = strings.ToUpper(callee.Name()), 0
	case "Post", "PostForm":
		method, urlArg = "POST", 0
	case "NewRequest":
		urlArg = 1
	case "NewRequestWithContext":
		urlArg = 2
	default:
		return
	}
	if urlArg >= len(call.Args) {
		return
	}
	raw, ok := constString(info, call.Args[urlArg])
	if !ok {
		return
	}
	if method == "" {
		if m, ok := constString(info, call.Args[urlArg-1]); ok {
			method = strings.ToUpper(m)
		} else {
			method = "?"
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" {
		return
	}
	id := graph.ExternalID(u.Host)
	l.ensureService(id, u.Host, map[string]any{"url": u.Scheme + "://" + u.Host})
	p := u.Path
	if p == "" {
		p = "/"
	}
	l.x.b.addEdge(graph.Edge{From: c.id, To: id, Type: graph.Calls, Detail: method + " " + p, File: file, Line: line})
}

// callPattern matching (config.go.jobs/subscribers/publishers).

// funcNames returns the full go/types name of f and the same with the package
// path shortened to the package name: "(*shop/internal/events.Bus).Publish" and
// "(*events.Bus).Publish".
func funcNames(f *types.Func) []string {
	full := f.Origin().FullName()
	if f.Pkg() == nil {
		return []string{full}
	}
	short := strings.Replace(full, f.Pkg().Path()+".", f.Pkg().Name()+".", 1)
	return []string{full, short}
}

func matchPattern(pats []project.CallPattern, names []string) *project.CallPattern {
	for i := range pats {
		for _, n := range names {
			if pats[i].Call == n {
				return &pats[i]
			}
		}
	}
	return nil
}

// callTargets returns the functions a call may invoke: its static callee plus
// what VTA resolved at the call site (so a call through an interface matches a
// pattern naming the implementation).
func (l *load) callTargets(call *ast.CallExpr, callee *types.Func) []*types.Func {
	var out []*types.Func
	if callee != nil {
		out = append(out, callee)
	}
	for _, fn := range l.sites[call.Lparen] {
		if f, ok := fn.Object().(*types.Func); ok {
			out = append(out, f)
		}
	}
	return out
}

func argAt(call *ast.CallExpr, i *int) ast.Expr {
	if i == nil || *i < 0 || *i >= len(call.Args) {
		return nil
	}
	return call.Args[*i]
}

func (l *load) patternCalls(c *fnCtx, call *ast.CallExpr, callee *types.Func, file string, line int) {
	g := l.x.cfg.Go
	if len(g.Jobs)+len(g.Subscribers)+len(g.Publishers) == 0 {
		return
	}
	var pj, ps, pp *project.CallPattern
	var matched *types.Func
	for _, f := range l.callTargets(call, callee) {
		names := funcNames(f)
		if pj == nil {
			pj = matchPattern(g.Jobs, names)
		}
		if ps == nil {
			ps = matchPattern(g.Subscribers, names)
		}
		if pp == nil {
			pp = matchPattern(g.Publishers, names)
		}
		if (pj != nil || ps != nil || pp != nil) && matched == nil {
			matched = f
		}
	}
	if matched == nil {
		return
	}
	info := c.p.TypesInfo
	verb := strings.ToLower(matched.Name())
	if pj != nil {
		l.jobCall(c, call, pj, verb, file, line)
	}
	if ps != nil {
		topic, ok := constString(info, argAt(call, ps.TopicArg))
		h := argAt(call, ps.HandlerArg)
		if ok && h != nil {
			hs := l.resolveHandler(c, h, 0)
			handlerID := hs.last()
			if handlerID == "" {
				handlerID = c.id
			}
			subID := graph.SubscriberID(topic, handlerID)
			l.x.b.addNode(graph.Node{ID: subID, Kind: graph.KindSubscriber, Label: topic, Module: c.mod, File: file, Line: line, Entry: true})
			topicID := l.ensureTopic(topic)
			l.x.b.addEdge(graph.Edge{From: topicID, To: subID, Type: graph.Subscribes, Detail: verb + " " + topic, File: file, Line: line})
			for _, id := range hs.all() {
				l.x.b.addEdge(graph.Edge{From: subID, To: id, Type: graph.Calls, File: file, Line: line})
			}
		}
	}
	if pp != nil {
		if topic, ok := constString(info, argAt(call, pp.TopicArg)); ok {
			topicID := l.ensureTopic(topic)
			if v := argAt(call, pp.ValueArg); v != nil {
				l.setMessage(topicID, info.TypeOf(v))
			}
			l.x.b.addEdge(graph.Edge{From: c.id, To: topicID, Type: graph.Publishes, Detail: topic, File: file, Line: line})
		}
	}
}

func (l *load) jobCall(c *fnCtx, call *ast.CallExpr, p *project.CallPattern, verb, file string, line int) {
	info := c.p.TypesInfo
	h := argAt(call, p.HandlerArg)
	if h == nil {
		return
	}
	hs := l.resolveHandler(c, h, 0)
	name, ok := constString(info, argAt(call, p.NameArg))
	if !ok {
		if p.NameArg != nil {
			return // a name argument that isn't constant: don't guess
		}
		if name = hs.last(); name == "" {
			return
		}
		if n := l.x.b.nodes[name]; n != nil {
			name = n.Label
		}
	}
	// Other arguments (the schedule, usually) are kept as source text under
	// the called method's name: s.Every(15*time.Minute, …) → every: "15*time.Minute".
	var rest []string
	for i, a := range call.Args {
		if (p.NameArg != nil && i == *p.NameArg) || i == *p.HandlerArg {
			continue
		}
		rest = append(rest, l.source(a))
	}
	var fields map[string]any
	if len(rest) > 0 {
		fields = map[string]any{verb: strings.Join(rest, ", ")}
	}
	id := graph.JobID(name)
	l.x.b.addNode(graph.Node{ID: id, Kind: graph.KindJob, Label: name, Module: c.mod, File: file, Line: line, Entry: true, Fields: fields})
	for _, to := range hs.all() {
		l.x.b.addEdge(graph.Edge{From: id, To: to, Type: graph.Calls, File: file, Line: line})
	}
}

func (l *load) ensureTopic(name string) string {
	id := graph.TopicID(name)
	if !l.x.b.has(id) {
		l.x.b.addModule(graph.Module{ID: topicsModule, Label: "topics", External: true})
		l.x.b.addNode(graph.Node{ID: id, Kind: graph.KindTopic, Label: name, Module: topicsModule, External: true})
	}
	return id
}

// setMessage sets a topic's fields.message to the declaration of the published
// value's type, if the topic doesn't have one yet.
func (l *load) setMessage(topicID string, t types.Type) {
	n := l.x.b.nodes[topicID]
	if t == nil || n == nil || n.Fields["message"] != nil {
		return
	}
	for {
		p, ok := t.(*types.Pointer)
		if !ok {
			break
		}
		t = p.Elem()
	}
	msg := map[string]any{"code": types.TypeString(t, func(p *types.Package) string { return p.Name() }), "lang": "go"}
	if named, ok := t.(*types.Named); ok {
		if code, file, line := l.typeDecl(named.Obj()); code != "" {
			msg = map[string]any{"code": code, "lang": "go", "file": file, "line": line}
		}
	}
	if n.Fields == nil {
		n.Fields = map[string]any{}
	}
	n.Fields["message"] = msg
}

// typeDecl returns the source of a repo type's declaration.
func (l *load) typeDecl(obj *types.TypeName) (code, file string, line int) {
	if !obj.Pos().IsValid() {
		return "", "", 0
	}
	pos := l.fset.Position(obj.Pos())
	if _, ok := l.x.rel(pos.Filename); !ok {
		return "", "", 0
	}
	for _, p := range l.plain {
		for _, f := range p.Syntax {
			if l.fset.Position(f.Pos()).Filename != pos.Filename {
				continue
			}
			for _, d := range f.Decls {
				gd, ok := d.(*ast.GenDecl)
				if !ok || gd.Tok != token.TYPE {
					continue
				}
				for _, s := range gd.Specs {
					ts := s.(*ast.TypeSpec)
					if ts.Name.Pos() != obj.Pos() {
						continue
					}
					if gd.Lparen.IsValid() {
						file, line = l.pos(ts.Pos())
						return "type " + l.source(ts), file, line
					}
					file, line = l.pos(gd.Pos())
					return l.source(gd), file, line
				}
			}
		}
	}
	return "", "", 0
}
