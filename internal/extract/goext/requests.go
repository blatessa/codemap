package goext

import (
	"go/ast"
	"go/token"
	"go/types"
	"sort"
	"strings"

	"github.com/blatessa/codemap/internal/graph"
)

// Requests the repo's Go code makes to its own HTTP API: a CLI calling its
// server, a worker calling an internal endpoint. They become fetches edges
// from the calling function to the route they reach, as frontend fetches do.
//
// A request's URL is evaluated as a string expression made of literal text,
// holes (anything not known statically: a base URL field, an ID formatted
// into the path) and, inside request helpers, references to the helper's
// parameters:
//
//	func (c *Client) do(method, path string) { http.NewRequest(method, c.URL+path, nil) }
//	func (c *Client) Approve(id int64)       { c.do("POST", fmt.Sprintf("/tasks/%d/approve", id)) }
//
// do is a request helper (method = parameter 0, URL = hole + parameter 1);
// Approve's call to it is a request POST <base>/tasks/{}/approve. Helper
// chains are followed a few levels. Once every go.mod has been extracted,
// requests are matched against the repo's routes (linkRequests); a URL that
// starts with a hole may match a suffix of a route's path, since the base URL
// usually carries a mount prefix.

type rpartKind uint8

const (
	pLit   rpartKind = iota
	pHole            // unknown at analysis time
	pParam           // the enclosing function's parameter
)

type rpart struct {
	kind  rpartKind
	lit   string
	param int
}

var hole = rpart{kind: pHole}

// reqTmpl is a request helper's request: its method and URL in terms of its
// parameters.
type reqTmpl struct {
	method rpart
	url    []rpart
}

func (t reqTmpl) key() string {
	var b strings.Builder
	for _, p := range append([]rpart{t.method}, t.url...) {
		switch p.kind {
		case pLit:
			b.WriteString("L" + p.lit + "\x00")
		case pHole:
			b.WriteString("H\x00")
		case pParam:
			b.WriteString("P" + string(rune('0'+p.param)) + "\x00")
		}
	}
	return b.String()
}

// request is a call to the repo's own API, waiting to be matched to a route.
type request struct {
	from, method string
	segs         [][]rpart // path segments, each literal text and holes
	prefix       bool      // the URL starts with something unknown (a base URL)
	file         string
	line         int
}

// reqLocals is what request evaluation needs to know about a function's
// local variables beyond fnCtx: how often each is assigned, and the call a
// variable is the first result of (u, err := url.Parse(…)).
type reqLocals struct {
	count map[types.Object]int
	tuple map[types.Object]*ast.CallExpr
}

func (c *fnCtx) reqLocals() *reqLocals {
	if c.rl != nil {
		return c.rl
	}
	rl := &reqLocals{count: map[types.Object]int{}, tuple: map[types.Object]*ast.CallExpr{}}
	c.rl = rl
	if c.body == nil {
		return rl
	}
	info := c.p.TypesInfo
	ast.Inspect(c.body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			for _, lhs := range s.Lhs {
				if id, ok := lhs.(*ast.Ident); ok {
					if o := objOf(info, id); o != nil {
						rl.count[o]++
					}
				}
			}
			if len(s.Rhs) == 1 && len(s.Lhs) > 1 {
				if id, ok := s.Lhs[0].(*ast.Ident); ok {
					if call, ok := ast.Unparen(s.Rhs[0]).(*ast.CallExpr); ok {
						if o := objOf(info, id); o != nil {
							rl.tuple[o] = call
						}
					}
				}
			}
		case *ast.ValueSpec:
			for _, id := range s.Names {
				if o := info.Defs[id]; o != nil {
					rl.count[o]++
				}
			}
		case *ast.IncDecStmt:
			if id, ok := s.X.(*ast.Ident); ok {
				rl.count[info.Uses[id]] += 2
			}
		case *ast.UnaryExpr:
			if id, ok := s.X.(*ast.Ident); ok && s.Op == token.AND {
				rl.count[info.Uses[id]] += 2
			}
		}
		return true
	})
	return rl
}

// reqEval evaluates a string expression to literal text, holes and parameter
// references.
func (l *load) reqEval(c *fnCtx, e ast.Expr, depth int) []rpart {
	info := c.p.TypesInfo
	if s, ok := c.stringValue(e); ok {
		return []rpart{{kind: pLit, lit: s}}
	}
	if depth > 8 {
		return []rpart{hole}
	}
	switch x := ast.Unparen(e).(type) {
	case *ast.Ident:
		if i := c.paramIndex(x); i >= 0 {
			return []rpart{{kind: pParam, param: i}}
		}
		obj := info.Uses[x]
		if v, ok := c.exprs[obj]; ok && c.reqLocals().count[obj] == 1 {
			return l.reqEval(c, v, depth+1)
		}
	case *ast.BinaryExpr:
		if x.Op == token.ADD && isString(info, x) {
			return append(l.reqEval(c, x.X, depth+1), l.reqEval(c, x.Y, depth+1)...)
		}
	case *ast.CallExpr:
		return l.reqEvalCall(c, x, depth)
	}
	return []rpart{hole}
}

func (l *load) reqEvalCall(c *fnCtx, call *ast.CallExpr, depth int) []rpart {
	info := c.p.TypesInfo
	f := staticCallee(info, call)
	if f == nil || f.Pkg() == nil {
		return []rpart{hole}
	}
	switch f.Pkg().Path() + "." + f.Name() {
	case "fmt.Sprintf":
		if len(call.Args) == 0 {
			break
		}
		format, ok := c.stringValue(call.Args[0])
		if !ok {
			break
		}
		return l.reqFormat(c, format, call.Args[1:], depth)
	case "path.Join":
		if call.Ellipsis.IsValid() {
			break
		}
		var out []rpart
		for i, a := range call.Args {
			if i > 0 {
				out = append(out, rpart{kind: pLit, lit: "/"})
			}
			out = append(out, l.reqEval(c, a, depth+1)...)
		}
		return out
	case "net/url.String":
		// u.String() for u, err := url.Parse(x): x
		sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr)
		if !ok {
			break
		}
		id, ok := ast.Unparen(sel.X).(*ast.Ident)
		if !ok {
			break
		}
		obj := info.Uses[id]
		src := c.reqLocals().tuple[obj]
		if src == nil || c.reqLocals().count[obj] != 1 || len(src.Args) != 1 {
			break
		}
		if pf := staticCallee(info, src); pf != nil && pf.Pkg() != nil && pf.Pkg().Path() == "net/url" &&
			(pf.Name() == "Parse" || pf.Name() == "ParseRequestURI") {
			return l.reqEval(c, src.Args[0], depth+1)
		}
	default:
		if t := l.strHelper(f); t != nil {
			var out []rpart
			for _, p := range t {
				if p.kind != pParam {
					out = append(out, p)
				} else if p.param < len(call.Args) && !call.Ellipsis.IsValid() {
					out = append(out, l.reqEval(c, call.Args[p.param], depth+1)...)
				} else {
					out = append(out, hole)
				}
			}
			return out
		}
	}
	return []rpart{hole}
}

// strHelper returns what a repo function returning one string returns, in
// terms of its parameters and up to any query string, if all its return
// statements agree: a path builder like withQuery(path, filter) returning
// path, or path with a query string appended, is its path parameter. Or nil.
func (l *load) strHelper(f *types.Func) []rpart {
	f = f.Origin()
	if t, ok := l.strHelpers[f]; ok {
		return t
	}
	l.strHelpers[f] = nil // recursion
	res := f.Signature().Results()
	if res.Len() != 1 {
		return nil
	}
	if b, ok := res.At(0).Type().Underlying().(*types.Basic); !ok || b.Info()&types.IsString == 0 {
		return nil
	}
	p, d := l.declOf(f)
	if d == nil {
		return nil
	}
	c := newFnCtx(p, "", "", f, d.Type, d.Body)
	var got []rpart
	key, agree := "", true
	ast.Inspect(d.Body, func(n ast.Node) bool {
		switch r := n.(type) {
		case *ast.FuncLit:
			return false
		case *ast.ReturnStmt:
			if len(r.Results) != 1 || !agree {
				agree = false
				return false
			}
			t := trimQuery(l.reqEval(c, r.Results[0], 4))
			k := reqTmpl{url: t}.key()
			if got != nil && k != key {
				agree = false
			}
			got, key = t, k
		}
		return agree
	})
	if !agree || got == nil {
		return nil
	}
	l.strHelpers[f] = got
	return got
}

// reqFormat evaluates fmt.Sprintf with a constant format: %s and %v of
// strings are their argument's value, other verbs are holes.
func (l *load) reqFormat(c *fnCtx, format string, args []ast.Expr, depth int) []rpart {
	var out []rpart
	var lit strings.Builder
	flush := func() {
		if lit.Len() > 0 {
			out = append(out, rpart{kind: pLit, lit: lit.String()})
			lit.Reset()
		}
	}
	arg := 0
	for i := 0; i < len(format); i++ {
		ch := format[i]
		if ch != '%' {
			lit.WriteByte(ch)
			continue
		}
		i++
		for i < len(format) && strings.IndexByte("+-# 0123456789.*[]", format[i]) >= 0 {
			i++
		}
		if i >= len(format) {
			break
		}
		if format[i] == '%' {
			lit.WriteByte('%')
			continue
		}
		flush()
		if (format[i] == 's' || format[i] == 'v') && arg < len(args) && isString(c.p.TypesInfo, args[arg]) {
			out = append(out, l.reqEval(c, args[arg], depth+1)...)
		} else {
			out = append(out, hole)
		}
		arg++
	}
	flush()
	return out
}

// httpRequest handles a net/http call that makes a request: its method and
// URL make either a request of c or, when they refer to c's parameters, make
// c a request helper.
func (l *load) httpRequest(c *fnCtx, call *ast.CallExpr, callee *types.Func, file string, line int) {
	if r := callee.Signature().Recv(); r != nil {
		if p, ok := r.Type().(*types.Pointer); !ok || p.Elem().String() != "net/http.Client" {
			return
		}
	}
	method, urlArg := rpart{kind: pLit}, -1
	switch callee.Name() {
	case "Get", "Head":
		method.lit, urlArg = strings.ToUpper(callee.Name()), 0
	case "Post", "PostForm":
		method.lit, urlArg = "POST", 0
	case "NewRequest":
		if callee.Signature().Recv() == nil {
			urlArg = 1
		}
	case "NewRequestWithContext":
		if callee.Signature().Recv() == nil {
			urlArg = 2
		}
	}
	if urlArg < 0 || urlArg >= len(call.Args) {
		return
	}
	if method.lit == "" {
		method = l.reqMethod(c, call.Args[urlArg-1])
	}
	l.reqFinish(c, reqTmpl{method: method, url: l.reqEval(c, call.Args[urlArg], 0)}, file, line)
}

func (l *load) reqMethod(c *fnCtx, e ast.Expr) rpart {
	p := l.reqEval(c, e, 0)
	if len(p) == 1 && p[0].kind == pLit {
		return rpart{kind: pLit, lit: strings.ToUpper(p[0].lit)}
	}
	if len(p) == 1 {
		return p[0]
	}
	return hole
}

// reqFinish records an evaluated request: as a request helper of c's function
// if it refers to c's parameters, otherwise as a request of c.
func (l *load) reqFinish(c *fnCtx, t reqTmpl, file string, line int) {
	param := t.method.kind == pParam
	for _, p := range t.url {
		param = param || p.kind == pParam
	}
	if param {
		if c.fn != nil {
			f := c.fn.Origin()
			k := t.key()
			if l.reqSeen[f] == nil {
				l.reqSeen[f] = map[string]bool{}
			}
			if !l.reqSeen[f][k] && len(l.reqSeen[f]) < 8 {
				l.reqSeen[f][k] = true
				l.reqWrappers[f] = append(l.reqWrappers[f], t)
			}
		}
		// A parameter right after a "/" is a value in the path (User(name)
		// requesting "/users/"+name), not the path itself (do(path)
		// requesting c.URL+path): the function is a request of its own too,
		// with a hole for the value.
		var url []rpart
		for i, p := range t.url {
			if p.kind == pParam {
				if i == 0 || t.url[i-1].kind != pLit || !strings.HasSuffix(t.url[i-1].lit, "/") {
					return
				}
				p = hole
			}
			url = append(url, p)
		}
		if t.method.kind == pParam {
			return
		}
		t.url = url
	}
	if t.method.kind != pLit || t.method.lit == "" || !l.x.b.has(c.id) {
		return
	}
	segs, prefix, ok := reqPath(t.url)
	if !ok {
		return
	}
	l.x.requests = append(l.x.requests, request{from: c.id, method: t.method.lit, segs: segs, prefix: prefix, file: file, line: line})
}

// trimQuery drops a URL's query string and fragment, and empty literals.
func trimQuery(url []rpart) []rpart {
	var out []rpart
	for _, p := range url {
		if p.kind == pLit {
			if i := strings.IndexAny(p.lit, "?#"); i >= 0 {
				if p.lit[:i] != "" {
					out = append(out, rpart{kind: pLit, lit: p.lit[:i]})
				}
				break
			}
			if p.lit == "" {
				continue
			}
		}
		out = append(out, p)
	}
	return out
}

// reqPath splits an evaluated URL into path segments, dropping the query and
// fragment. It rejects absolute URLs (another service: see httpCall), URLs
// whose path has no literal text, and relative ones not starting with a hole
// or "/".
func reqPath(url []rpart) (segs [][]rpart, prefix bool, ok bool) {
	parts := trimQuery(url)
	for len(parts) > 0 && parts[0].kind == pHole {
		prefix = true
		parts = parts[1:]
	}
	if len(parts) == 0 {
		return nil, false, false
	}
	if first := parts[0].lit; !prefix && !strings.HasPrefix(first, "/") || strings.Contains(first, "://") || strings.HasPrefix(first, "//") {
		return nil, false, false
	}
	var cur []rpart
	end := func() {
		if len(cur) > 0 {
			segs = append(segs, cur)
		}
		cur = nil
	}
	for _, p := range parts {
		if p.kind != pLit {
			if len(cur) == 0 || cur[len(cur)-1].kind != pHole {
				cur = append(cur, hole)
			}
			continue
		}
		for i, s := range strings.Split(p.lit, "/") {
			if i > 0 {
				end()
			}
			if s != "" {
				cur = append(cur, rpart{kind: pLit, lit: s})
			}
		}
	}
	end()
	for _, s := range segs {
		if s[0].kind == pLit || len(s) > 1 {
			return segs, prefix, true
		}
	}
	return nil, false, false
}

// reqWrapperCalls follows requests through request helpers: a call to one is
// its request with the call's arguments for the helper's parameters.
func (l *load) reqWrapperCalls() {
	done := map[*types.Func]int{} // templates already applied
	for round := 0; round < 5; round++ {
		todo := map[*types.Func][]reqTmpl{}
		for f, ts := range l.reqWrappers {
			if done[f] < len(ts) {
				todo[f] = ts[done[f]:]
				done[f] = len(ts)
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
				ts := todo[callee.Origin()]
				if len(ts) == 0 {
					return true
				}
				sig := callee.Signature()
				file, line := l.pos(call.Pos())
				arg := func(i int) []rpart {
					if i >= len(call.Args) || sig.Variadic() && i >= sig.Params().Len()-1 {
						return []rpart{hole}
					}
					return l.reqEval(c, call.Args[i], 0)
				}
				for _, t := range ts {
					var nt reqTmpl
					nt.method = t.method
					if t.method.kind == pParam {
						nt.method = hole
						if t.method.param < len(call.Args) {
							nt.method = l.reqMethod(c, call.Args[t.method.param])
						}
					}
					for _, p := range t.url {
						if p.kind == pParam {
							nt.url = append(nt.url, arg(p.param)...)
						} else {
							nt.url = append(nt.url, p)
						}
					}
					l.reqFinish(c, nt, file, line)
				}
				return true
			})
		})
	}
}

// linkRequests adds a fetches edge from each request to the route it reaches.
// The path must equal the route's, or, when the URL starts with a base URL,
// be a suffix of it at a segment boundary. A hole matches within one segment
// and a route parameter matches any segment. Among several matches the one
// agreeing with the most literal route segments wins, then an exact one over
// a suffix. A literal landing on a route parameter agrees with nothing and a
// hole landing on a literal counts against: "/tasks/{}/{}" is
// /:tenant/api/tasks/:id/:action rather than /:tenant/api/tasks or
// /:tenant/api/tasks/:id/approve. A match must agree literally on two of the
// request's segments with literal text, or on its only one: "/{}/tags" or
// "/pullrequests/{}/comments" from another service's client match nothing.
// Remaining ties are all linked. A request matching no route adds nothing.
func (x *extractor) linkRequests() {
	type route struct {
		id, method string
		segs       []string
	}
	var routes []route
	for id, n := range x.b.nodes {
		if n.Kind != graph.KindRoute || n.External {
			continue
		}
		m, p, ok := graph.SplitRouteID(id)
		if !ok {
			continue
		}
		var segs []string
		for _, s := range strings.Split(p, "/") {
			if s != "" {
				segs = append(segs, s)
			}
		}
		routes = append(routes, route{id, m, segs})
	}
	sort.Slice(routes, func(i, j int) bool { return routes[i].id < routes[j].id })
	for _, r := range x.requests {
		var best []string
		bestExact, bestLits := false, 0
		need := 0 // literal agreement required
		for _, s := range r.segs {
			if s[0].kind == pLit || len(s) > 1 {
				need++
			}
		}
		need = min(need, 2)
		for _, rt := range routes {
			if rt.method != r.method && rt.method != "ANY" && !(rt.method == "GET" && r.method == "HEAD") {
				continue
			}
			exact := len(rt.segs) == len(r.segs)
			if !exact && (!r.prefix || len(rt.segs) < len(r.segs)) {
				continue
			}
			off := len(rt.segs) - len(r.segs)
			// a literal segment agreeing scores 2, one with holes 1, a bare hole -1
			lits, agree, ok := 0, 0, true
			for i, s := range r.segs {
				rs := rt.segs[off+i]
				if rs[0] == ':' || rs[0] == '*' {
					continue
				}
				if !segMatch(s, rs) {
					ok = false
					break
				}
				if len(s) == 1 && s[0].kind == pLit {
					lits += 2
					agree++
				} else if s[0].kind == pLit || len(s) > 1 {
					lits++
					agree++
				} else {
					lits-- // a bare hole fits a route parameter better
				}
			}
			if !ok || agree < need {
				continue
			}
			switch {
			case best != nil && lits == bestLits && exact == bestExact:
				best = append(best, rt.id)
			case best == nil || lits > bestLits || lits == bestLits && exact && !bestExact:
				best, bestExact, bestLits = []string{rt.id}, exact, lits
			}
		}
		detail := r.method + " " + r.path()
		for _, to := range best {
			x.b.addEdge(graph.Edge{From: r.from, To: to, Type: graph.Fetches, Detail: detail, File: r.file, Line: r.line})
		}
	}
}

func (r request) path() string {
	var b strings.Builder
	for _, s := range r.segs {
		b.WriteByte('/')
		for _, p := range s {
			if p.kind == pLit {
				b.WriteString(p.lit)
			} else {
				b.WriteString("{}")
			}
		}
	}
	return b.String()
}

// segMatch matches a segment of literal text and holes against a literal
// route segment, a hole standing for any text.
func segMatch(s []rpart, rs string) bool {
	if len(s) == 0 {
		return rs == ""
	}
	if s[0].kind == pLit {
		rest, ok := strings.CutPrefix(rs, s[0].lit)
		return ok && segMatch(s[1:], rest)
	}
	for i := 0; i <= len(rs); i++ {
		if segMatch(s[1:], rs[i:]) {
			return true
		}
	}
	return false
}
