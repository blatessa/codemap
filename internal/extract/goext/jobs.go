package goext

import (
	"go/ast"
	"go/token"
	"go/types"
	"strconv"

	"github.com/blatessa/codemap/internal/graph"
)

// Background jobs the program starts itself: a goroutine started at startup
// that loops on a timer,
//
//	go cleanupScheduler(store, freq)          // for range time.Tick(freq) { … }
//	go func() { for { …; time.Sleep(d) } }()
//	ticker := time.NewTicker(d); go func() { for range ticker.C { … } }()
//	go w.run()                                 // for { select { case <-t.C: … } }
//
// or works through a channel (go worker.Run(queue): for job := range queue,
// or for { select { case job := <-queue: … } }), and functions scheduled with
// time.AfterFunc(d, f). Each becomes a job entry named after the function it
// runs (the enclosing function's name for a literal), with fields.every (or
// fields.after) holding the interval's source text, and calls edges to what
// it runs, resolved as for configured jobs. Only code reached from main, a
// command or an init function, and not through a route or subscriber
// handler, counts: a goroutine started per request is not a job. A goroutine
// that runs once (go send(msg)) stays an ordinary call.

// startupReach returns the repo functions reached at startup: from main
// functions, commands and init functions over calls edges, without entering a
// route's or subscriber's handlers.
func (l *load) startupReach() map[string]bool {
	b := l.x.b
	out := map[string][]string{}
	handler := map[string]bool{}
	for k := range b.edges {
		if k[2] != graph.Calls {
			continue
		}
		out[k[0]] = append(out[k[0]], k[1])
		if n := b.nodes[k[0]]; n != nil && (n.Kind == graph.KindRoute || n.Kind == graph.KindSubscriber) {
			handler[k[1]] = true
		}
	}
	seen := map[string]bool{}
	var q []string
	for id, n := range b.nodes {
		root := n.Kind == graph.KindCommand ||
			n.Kind == graph.KindFunction && (n.Entry && n.Label == "main" || n.Label == "init" || n.Label == initLabel)
		if root && !n.External {
			seen[id] = true
			q = append(q, id)
		}
	}
	for len(q) > 0 {
		id := q[0]
		q = q[1:]
		for _, to := range out[id] {
			if !seen[to] && !handler[to] {
				seen[to] = true
				q = append(q, to)
			}
		}
	}
	return seen
}

// addBackgroundJobs adds a job for each background loop started at startup.
func (l *load) addBackgroundJobs() {
	reached := l.startupReach()
	used := map[string]token.Pos{} // job names taken by literals → their site
	l.eachFunc(func(c *fnCtx, body ast.Node) {
		if !reached[c.id] || !l.x.b.has(c.id) {
			return
		}
		info := c.p.TypesInfo
		var stack []ast.Node
		ast.Inspect(body, func(n ast.Node) bool {
			if n == nil {
				stack = stack[:len(stack)-1]
				return true
			}
			stack = append(stack, n)
			switch s := n.(type) {
			case *ast.GoStmt:
				if !perEvent(info, stack) {
					l.goJob(c, s, used)
				}
			case *ast.CallExpr:
				if f := staticCallee(info, s); isPkgFunc(f, "time", "AfterFunc") && len(s.Args) == 2 {
					l.addJob(c, s.Args[1], s.Pos(), "after", l.source(s.Args[0]), used)
				}
			}
			return true
		})
	})
}

// perEvent reports whether a go statement (last on the stack of nodes
// enclosing it) is inside a loop that waits for events, an accept loop or a
// loop over a channel: a goroutine per connection or message, not one
// started once. Counting loops (starting n workers) don't count.
func perEvent(info *types.Info, stack []ast.Node) bool {
	for _, n := range stack[:len(stack)-1] {
		switch x := n.(type) {
		case *ast.ForStmt:
			if x.Init == nil && x.Post == nil {
				return true
			}
		case *ast.RangeStmt:
			if t := info.TypeOf(x.X); t != nil {
				if _, ok := t.Underlying().(*types.Chan); ok {
					return true
				}
			}
		}
	}
	return false
}

func isPkgFunc(f *types.Func, pkg, name string) bool {
	return f != nil && f.Pkg() != nil && f.Pkg().Path() == pkg && f.Name() == name && f.Signature().Recv() == nil
}

// goJob makes a job of a go statement starting a loop.
func (l *load) goJob(c *fnCtx, s *ast.GoStmt, used map[string]token.Pos) {
	var lc *fnCtx // where the loop's code is
	var body ast.Node
	if lit, ok := ast.Unparen(s.Call.Fun).(*ast.FuncLit); ok {
		lc, body = c, lit.Body
	} else {
		f := staticCallee(c.p.TypesInfo, s.Call)
		if f == nil || f.Pkg() == nil || !l.isRepoPkg(f.Pkg().Path()) {
			return
		}
		p, d := l.declOf(f.Origin())
		if d == nil || d.Body == nil {
			return
		}
		lc, body = newFnCtx(p, "", "", f.Origin(), d.Type, d.Body), d.Body
	}
	kind, every, ok := l.backgroundLoop(lc, body)
	if ok {
		l.addJob(c, s.Call.Fun, s.Pos(), kind, every, used)
	}
}

// addJob adds the job running h, started at pos in c.
func (l *load) addJob(c *fnCtx, h ast.Expr, pos token.Pos, key, interval string, used map[string]token.Pos) {
	// What a literal runs through the enclosing function's parameters is the
	// caller's: a scheduling helper's goroutine (Every(d, fn) looping over
	// fn()) is not a job of its own.
	skip := map[token.Pos]bool{}
	skipFunc := func(obj types.Object) {
		if obj != nil {
			if _, ok := obj.Type().Underlying().(*types.Signature); ok {
				skip[obj.Pos()] = true
			}
		}
	}
	for obj := range c.params {
		skipFunc(obj)
	}
	ast.Inspect(c.body, func(n ast.Node) bool { // and the parameters of literals in it (Debounce returning func(f func()))
		if lit, ok := n.(*ast.FuncLit); ok {
			for _, f := range lit.Type.Params.List {
				for _, name := range f.Names {
					skipFunc(c.p.TypesInfo.Defs[name])
				}
			}
		}
		return true
	})
	hs := l.resolveHandlerSkip(c, h, 0, skip)
	name := ""
	if _, lit := ast.Unparen(h).(*ast.FuncLit); !lit {
		if id := hs.last(); id != "" {
			if n := l.x.b.nodes[id]; n != nil {
				name = n.Label
			}
		}
	}
	if name == "" {
		// a literal: named after the function starting it, numbered when it
		// starts several
		n := l.x.b.nodes[c.id]
		if n == nil {
			return
		}
		name = n.Label
		for i := 2; ; i++ {
			if p, ok := used[name]; !ok || p == pos {
				break
			}
			name = n.Label + " #" + strconv.Itoa(i)
		}
		used[name] = pos
	}
	if len(hs.all()) == 0 {
		return
	}
	var fields map[string]any
	if key != "" && interval != "" {
		fields = map[string]any{key: interval}
	}
	file, line := l.pos(pos)
	id := graph.JobID(name)
	l.x.b.addNode(graph.Node{ID: id, Kind: graph.KindJob, Label: name, Module: c.mod, File: file, Line: line, Entry: true, Fields: fields})
	for _, to := range hs.all() {
		l.x.b.addEdge(graph.Edge{From: id, To: to, Type: graph.Calls, File: file, Line: line})
	}
}

// backgroundLoop reports whether a goroutine's body runs a long-lived loop:
// one paced by a timer (kind "every", with the interval's source when it's
// visible) or one working through a channel (kind "").
func (l *load) backgroundLoop(c *fnCtx, body ast.Node) (kind, every string, ok bool) {
	info := c.p.TypesInfo
	timer, worker := false, false
	// interval returns the source of the period a timer channel fires with:
	// d for time.Tick(d), time.After(d) and time.NewTimer(d).C made afresh
	// each time round, and t.C for t := time.NewTicker(d). A timer kept in a
	// variable is usually reset to other durations (a debounce), so it has
	// none.
	interval := func(e ast.Expr) string {
		if call, ok := ast.Unparen(e).(*ast.CallExpr); ok {
			if f := staticCallee(info, call); (isPkgFunc(f, "time", "Tick") || isPkgFunc(f, "time", "After")) && len(call.Args) == 1 {
				return l.source(call.Args[0])
			}
		}
		sel, ok := ast.Unparen(e).(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "C" {
			return ""
		}
		made, fresh := ast.Unparen(sel.X), true
		if id, ok := made.(*ast.Ident); ok {
			made, fresh = c.exprs[info.Uses[id]], false
		}
		if call, ok := ast.Unparen(made).(*ast.CallExpr); ok && len(call.Args) == 1 {
			if f := staticCallee(info, call); isPkgFunc(f, "time", "NewTicker") || fresh && isPkgFunc(f, "time", "NewTimer") {
				return l.source(call.Args[0])
			}
		}
		return ""
	}
	// classify a channel received from in the loop
	recv := func(ch ast.Expr) {
		if isTimerChan(info, ch) {
			timer = true
			if every == "" {
				every = interval(ch)
			}
			return
		}
		if _, call := ast.Unparen(ch).(*ast.CallExpr); call {
			return // ctx.Done() and the like
		}
		// a channel of values to work on, not a signal (chan struct{}, a stop channel)
		if t, ok := info.TypeOf(ch).Underlying().(*types.Chan); ok {
			if s, ok := t.Elem().Underlying().(*types.Struct); !ok || s.NumFields() > 0 {
				if t.Elem().String() != "os.Signal" && t.Elem().String() != "bool" {
					worker = true
				}
			}
		}
	}
	// inLoop looks through a loop's body for sleeps and receives.
	inLoop := func(n ast.Node) {
		ast.Inspect(n, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.FuncLit:
				return false
			case *ast.CallExpr:
				if f := staticCallee(info, x); isPkgFunc(f, "time", "Sleep") && len(x.Args) == 1 {
					timer = true
					if every == "" {
						every = l.source(x.Args[0])
					}
				}
			case *ast.UnaryExpr:
				if x.Op == token.ARROW {
					recv(x.X)
				}
			}
			return true
		})
	}
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.FuncLit:
			return false
		case *ast.RangeStmt:
			if t, ok := info.TypeOf(x.X).Underlying().(*types.Chan); ok && t != nil {
				recv(x.X)
				inLoop(x.Body)
			}
		case *ast.ForStmt:
			if x.Init == nil && x.Post == nil {
				before := worker
				inLoop(x.Body)
				if x.Cond != nil {
					worker = before // a conditional loop only counts when paced by a timer
				}
			}
		}
		return true
	})
	switch {
	case timer:
		return "every", every, true
	case worker:
		return "", "", true
	}
	return "", "", false
}

// isTimerChan reports whether ch is a timer's channel: time.Tick(d),
// time.After(d), or the C field of a *time.Ticker or *time.Timer.
func isTimerChan(info *types.Info, ch ast.Expr) bool {
	switch x := ast.Unparen(ch).(type) {
	case *ast.CallExpr:
		f := staticCallee(info, x)
		return isPkgFunc(f, "time", "Tick") || isPkgFunc(f, "time", "After")
	case *ast.SelectorExpr:
		if x.Sel.Name != "C" {
			return false
		}
		t := info.TypeOf(x.X)
		if p, ok := t.(*types.Pointer); ok {
			t = p.Elem()
		}
		if n, ok := t.(*types.Named); ok && n.Obj().Pkg() != nil && n.Obj().Pkg().Path() == "time" {
			return n.Obj().Name() == "Ticker" || n.Obj().Name() == "Timer"
		}
	}
	return false
}
