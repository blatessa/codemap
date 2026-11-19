package goext

import (
	"go/ast"
	"go/types"
	"sort"
)

// Request builders: a method making a request to a URL held in one of its
// receiver's fields, set by a constructor or another method from a parameter,
//
//	func NewRequestBuilder(endpoint string) *requestBuilder { return &requestBuilder{endpoint: endpoint, method: "GET"} }
//	func (r *requestBuilder) WithMethod(m string) *requestBuilder { r.method = m; return r }
//	func (r *requestBuilder) Do() (*http.Response, error) { req, _ := http.NewRequest(r.method, r.endpoint, r.body); … }
//
// makes its request for whoever builds the receiver in the same expression or
// local variable: client.NewRequestBuilder(c.webhookURL).WithMethod("POST").Do()
// is a POST request of the calling function, to c.webhookURL. A builder
// method no call site resolves makes the request itself.

// fieldReq is a request whose URL (and maybe method) is a receiver field.
type fieldReq struct {
	url, method *types.Var // method is nil when the method isn't a field
	tmpl        reqTmpl    // the request with the method as known at the call
	file        string
	line        int
}

// receiverField returns the field e selects from fn's receiver (r.endpoint), or nil.
func receiverField(c *fnCtx, e ast.Expr) *types.Var {
	if c.fn == nil || c.fn.Signature().Recv() == nil {
		return nil
	}
	sel, ok := ast.Unparen(e).(*ast.SelectorExpr)
	if !ok {
		return nil
	}
	id, ok := ast.Unparen(sel.X).(*ast.Ident)
	if !ok || c.p.TypesInfo.Uses[id] != c.fn.Signature().Recv() {
		return nil
	}
	s, ok := c.p.TypesInfo.Selections[sel]
	if !ok || s.Kind() != types.FieldVal {
		return nil
	}
	v, _ := s.Obj().(*types.Var)
	return v
}

// fieldRequest records a request to a receiver field's URL, reporting
// whether urlExpr is one.
func (l *load) fieldRequest(c *fnCtx, urlExpr, methodExpr ast.Expr, method rpart, origin reqOrigin, file string, line int) bool {
	u := receiverField(c, urlExpr)
	if u == nil || !isString(c.p.TypesInfo, urlExpr) {
		return false
	}
	fr := &fieldReq{url: u, tmpl: reqTmpl{method: method, origin: origin}, file: file, line: line}
	if method.kind != pLit {
		fr.method = receiverField(c, methodExpr)
	}
	l.fieldReqs[c.fn.Origin()] = append(l.fieldReqs[c.fn.Origin()], fr)
	return true
}

// fieldRequests resolves request builders at their call sites (see above).
func (l *load) fieldRequests() {
	if len(l.fieldReqs) == 0 {
		return
	}
	fields := map[*types.Var]bool{}
	for _, frs := range l.fieldReqs {
		for _, fr := range frs {
			fields[fr.url] = true
			if fr.method != nil {
				fields[fr.method] = true
			}
		}
	}
	// setters: functions storing a parameter in one of those fields, and
	// constant defaults from composite literals
	setters := map[*types.Func]map[*types.Var]int{}
	l.fieldSetters = setters
	defaults := map[*types.Var]string{}
	set := func(c *fnCtx, field types.Object, v ast.Expr) {
		fv, ok := field.(*types.Var)
		if !ok || !fields[fv] {
			return
		}
		if i := c.paramIndex(v); i >= 0 && c.fn != nil {
			f := c.fn.Origin()
			if setters[f] == nil {
				setters[f] = map[*types.Var]int{}
			}
			setters[f][fv] = i
		} else if s, ok := c.stringValue(v); ok {
			if _, seen := defaults[fv]; !seen {
				defaults[fv] = s
			}
		}
	}
	l.eachFunc(func(c *fnCtx, body ast.Node) {
		info := c.p.TypesInfo
		ast.Inspect(body, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.CompositeLit:
				for _, el := range x.Elts {
					if kv, ok := el.(*ast.KeyValueExpr); ok {
						if k, ok := kv.Key.(*ast.Ident); ok && info.Uses[k] != nil {
							set(c, info.Uses[k], kv.Value)
						}
					}
				}
			case *ast.AssignStmt:
				if len(x.Lhs) != len(x.Rhs) {
					return true
				}
				for i, lhs := range x.Lhs {
					if sel, ok := lhs.(*ast.SelectorExpr); ok {
						if s, ok := info.Selections[sel]; ok && s.Kind() == types.FieldVal {
							set(c, s.Obj(), x.Rhs[i])
						}
					}
				}
			}
			return true
		})
	})

	called := map[*types.Func]bool{}
	self := map[*types.Func]bool{} // some call site builds the receiver elsewhere
	l.eachFunc(func(c *fnCtx, body ast.Node) {
		if !l.x.b.has(c.id) {
			return
		}
		info := c.p.TypesInfo
		ast.Inspect(body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			callee := staticCallee(info, call)
			if callee == nil || l.fieldReqs[callee.Origin()] == nil {
				return true
			}
			sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr)
			if !ok {
				return true
			}
			file, line := l.pos(call.Pos())
			for _, fr := range l.fieldReqs[callee.Origin()] {
				urlArg, methodArg := l.builderArgs(c, sel.X, fr)
				called[callee.Origin()] = true
				if urlArg == nil {
					self[callee.Origin()] = true
					continue
				}
				t := reqTmpl{method: fr.tmpl.method, origin: fr.tmpl.origin, url: l.reqEval(c, urlArg, 0)}
				t.origin.direct = false
				if fr.method != nil {
					t.method = hole
					if methodArg != nil {
						t.method = l.reqMethod(c, methodArg)
					} else if d, ok := defaults[fr.method]; ok {
						t.method = rpart{kind: pLit, lit: d}
					}
				}
				l.reqFinish(c, t, file, line)
			}
			return true
		})
	})
	var fs []*types.Func
	for f := range l.fieldReqs {
		if self[f] || !called[f] {
			fs = append(fs, f)
		}
	}
	sort.Slice(fs, func(i, j int) bool { return fs[i].Pos() < fs[j].Pos() })
	for _, f := range fs {
		for _, fr := range l.fieldReqs[f] {
			t := fr.tmpl
			t.url = []rpart{hole}
			if fr.method != nil {
				t.method = hole
			}
			l.addRequest(l.funcID(f), t, fr.file, fr.line)
		}
	}
}

// builderArgs walks a builder chain back from the receiver of a call to a
// request method, NewRequestBuilder(u).WithMethod(m).WithJSON(x), and
// returns the arguments set as the request's URL and method, or nil. Only
// one expression counts: a client kept in a variable (c := NewClient(url);
// c.Save(…)) makes its requests itself, with the URL it was configured with.
func (l *load) builderArgs(c *fnCtx, recv ast.Expr, fr *fieldReq) (urlArg, methodArg ast.Expr) {
	info := c.p.TypesInfo
	x := recv
	for depth := 0; depth < 16; depth++ {
		switch v := ast.Unparen(x).(type) {
		case *ast.CallExpr:
			g := staticCallee(info, v)
			if g == nil {
				return urlArg, methodArg
			}
			if s := l.fieldSetters[g.Origin()]; s != nil {
				if i, ok := s[fr.url]; ok && urlArg == nil && i < len(v.Args) {
					urlArg = v.Args[i]
				}
				if fr.method != nil {
					if i, ok := s[fr.method]; ok && methodArg == nil && i < len(v.Args) {
						methodArg = v.Args[i]
					}
				}
			}
			sel, ok := ast.Unparen(v.Fun).(*ast.SelectorExpr)
			if !ok || g.Signature().Recv() == nil {
				return urlArg, methodArg
			}
			x = sel.X
			continue
		}
		return urlArg, methodArg
	}
	return urlArg, methodArg
}
