package goext

import (
	"go/token"
	"go/types"

	"golang.org/x/tools/go/ssa"
)

// Callbacks: a helper that calls a function it was given as a parameter
// (db.WithTx(ctx, func…), retry.Do(f), lock.Do(key, f)). The call graph
// resolves that call to every function anyone ever passes the helper, so every
// caller of WithTx would seem to reach every transaction in the codebase. The
// call belongs to whoever passed the function instead:
//
//   - the helper keeps no edges from its calls to the parameter;
//   - a caller passing a named function or method gets an edge to it;
//   - a caller passing a closure needs nothing: the closure's calls are already
//     the caller's (closures are part of the function that writes them);
//   - a caller passing something that can't be traced (a field, a map entry,
//     a call result), or calling the helper through a function value, gets
//     everything the helper used to call, so no path is lost.
//
// Forwarding (WithTx passing f on to txWithNoCheck) and wrapping (WithTx2
// wrapping f in a closure it passes to WithTx) follow through. Only calls the
// helper makes before it returns count, plus calls in a closure it returns (a
// decorator such as HTTP middleware: wrap(h) runs h for whoever passed it). A
// function it starts with `go` or stores for later is a registration (a job, a
// handler), and keeps its edges.

// cbParam is parameter i of fn (receivers count, as in ssa.Function.Params).
type cbParam struct {
	fn *ssa.Function
	i  int
}

type forward struct {
	to   cbParam
	call ssa.CallInstruction
}

type callbacks struct {
	l       *load
	closure map[*ssa.Function]*ssa.MakeClosure // anonymous function → where it's made
	direct  map[cbParam][]ssa.CallInstruction  // calls of the parameter's value
	fwd     map[cbParam][]forward              // the parameter passed on to another function
	params  map[cbParam]bool                   // the callback parameters
	byFn    map[*ssa.Function][]int            // callback parameter indexes per helper
	skip    map[ssa.CallInstruction]bool       // call sites in helpers whose edges are dropped
	all     map[cbParam][]*ssa.Function        // what the helper used to call through p
}

func (l *load) findCallbacks(fns []*ssa.Function) *callbacks {
	cb := &callbacks{
		l:       l,
		closure: map[*ssa.Function]*ssa.MakeClosure{},
		direct:  map[cbParam][]ssa.CallInstruction{},
		fwd:     map[cbParam][]forward{},
		byFn:    map[*ssa.Function][]int{},
		skip:    map[ssa.CallInstruction]bool{},
		all:     map[cbParam][]*ssa.Function{},
	}
	cand := map[cbParam]bool{}
	for _, fn := range fns {
		for _, b := range fn.Blocks {
			for _, in := range b.Instrs {
				call, ok := in.(ssa.CallInstruction)
				if !ok {
					continue
				}
				if _, async := in.(*ssa.Go); async {
					continue // runs later, on its own: not part of the helper's work
				}
				c := call.Common()
				if c.IsInvoke() {
					continue
				}
				g := c.StaticCallee()
				if g == nil {
					for _, p := range cb.onlyParams(c.Value) {
						cb.direct[p] = append(cb.direct[p], call)
						cand[p] = true
					}
					continue
				}
				for i, a := range c.Args {
					if !isFunc(a.Type()) {
						continue
					}
					for _, p := range cb.onlyParams(a) {
						q := cbParam{g, i}
						cb.fwd[p] = append(cb.fwd[p], forward{q, call})
						cand[p], cand[q] = true, true
					}
				}
			}
		}
	}
	// Keep the parameters the helper calls before it returns: directly, or in
	// closures it calls itself or passes on to other callback helpers. Dropping
	// one can make a parameter forwarded to it fail in turn.
	for changed := true; changed; {
		changed = false
		for p := range cand {
			if !cb.calledInline(p, cand) {
				delete(cand, p)
				changed = true
			}
		}
	}
	cb.params = cand
	for p := range cand {
		cb.byFn[p.fn] = append(cb.byFn[p.fn], p.i)
		for _, call := range cb.direct[p] {
			if !cb.synchronous(call.Parent(), p.fn, cand) {
				continue
			}
			only := true // every parameter the call may be is a callback
			for _, q := range cb.onlyParams(call.Common().Value) {
				only = only && cand[q]
			}
			if only {
				cb.skip[call] = true
			}
		}
	}
	return cb
}

func (cb *callbacks) calledInline(p cbParam, cand map[cbParam]bool) bool {
	if p.i >= len(p.fn.Params) || !isFunc(p.fn.Params[p.i].Type()) {
		return false
	}
	for _, call := range cb.direct[p] {
		if cb.synchronous(call.Parent(), p.fn, cand) {
			return true
		}
	}
	for _, f := range cb.fwd[p] {
		if cand[f.to] && cb.synchronous(f.call.Parent(), p.fn, cand) {
			return true
		}
	}
	return false
}

// synchronous reports whether code in f runs while helper runs: f is helper,
// or a closure in it that is only ever called on the spot, deferred, or passed
// to a callback parameter.
func (cb *callbacks) synchronous(f, helper *ssa.Function, cand map[cbParam]bool) bool {
	for f != helper {
		mc := cb.makeClosure(f)
		if mc == nil || f.Parent() == nil {
			return false
		}
		refs := mc.Referrers()
		if refs == nil {
			return false
		}
		for _, r := range *refs {
			switch x := r.(type) {
			case *ssa.Call, *ssa.Defer:
				c := x.(ssa.CallInstruction).Common()
				if c.Value == mc {
					continue
				}
				g := c.StaticCallee()
				if g == nil || c.IsInvoke() {
					return false
				}
				for i, a := range c.Args {
					if a == mc && !cand[cbParam{g, i}] {
						return false
					}
				}
			case *ssa.DebugRef:
			case *ssa.Return:
				// A decorator: wrap(h) returns a closure that calls h (HTTP
				// middleware, s.wrap(handler)). Calling the result runs h for
				// whoever passed it, so the call is theirs, as if made now.
			case *ssa.ChangeType, *ssa.Convert, *ssa.MakeInterface:
				if !onlyReturned(x.(ssa.Value)) {
					return false
				}
			default:
				return false // launched with go, stored…
			}
		}
		f = f.Parent()
	}
	return true
}

// targets returns everything the call graph said helper p.fn calls through
// p, following forwarding: the fallback for callers that can't be traced.
func (cb *callbacks) targets(p cbParam) []*ssa.Function {
	if t, ok := cb.all[p]; ok {
		return t
	}
	cb.all[p] = nil // cycle guard
	seen := map[*ssa.Function]bool{}
	var out []*ssa.Function
	add := func(f *ssa.Function) {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	for _, call := range cb.direct[p] {
		if !cb.skip[call] {
			continue
		}
		if n := cb.l.cg.Nodes[call.Parent()]; n != nil {
			for _, e := range n.Out {
				if e.Site == call {
					add(e.Callee.Func)
				}
			}
		}
	}
	for _, f := range cb.fwd[p] {
		if cb.params[f.to] {
			for _, t := range cb.targets(f.to) {
				add(t)
			}
		}
	}
	cb.all[p] = out
	return out
}

// passed returns the functions fn hands callback helpers, attributed to fn:
// named functions and bound methods it passes, or, where what it passes can't
// be traced or the helper is called through a value, everything the helper
// used to call. Closures are left out; their calls are already fn's own.
func (cb *callbacks) passed(fn *ssa.Function) []passedFunc {
	n := cb.l.cg.Nodes[fn]
	if n == nil {
		return nil
	}
	var out []passedFunc
	for _, e := range n.Out {
		h := e.Callee.Func
		idx := cb.byFn[h]
		if e.Site == nil || len(idx) == 0 {
			continue
		}
		c := e.Site.Common()
		static := !c.IsInvoke() && c.StaticCallee() == h
		for _, i := range idx {
			p := cbParam{h, i}
			fallback := !static || i >= len(c.Args)
			var leaves []ssa.Value
			if !fallback {
				var ok bool
				leaves, ok = cb.sources(c.Args[i])
				fallback = !ok
			}
			for _, v := range leaves {
				switch x := v.(type) {
				case *ssa.Function:
					out = append(out, passedFunc{e.Site, x})
				case *ssa.MakeClosure:
					if f := x.Fn.(*ssa.Function); f.Synthetic != "" {
						out = append(out, passedFunc{e.Site, f}) // a bound method value
					}
				case *ssa.Parameter:
					if q, ok := cb.paramOf(x); !ok || !cb.params[q] {
						fallback = true // fn's own parameter, which isn't a callback
					}
				}
			}
			if fallback {
				for _, t := range cb.targets(p) {
					out = append(out, passedFunc{e.Site, t})
				}
			}
		}
	}
	return out
}

type passedFunc struct {
	site ssa.CallInstruction
	fn   *ssa.Function
}

// onlyParams returns the parameters v can be, if v can only ever be parameters.
func (cb *callbacks) onlyParams(v ssa.Value) []cbParam {
	leaves, ok := cb.sources(v)
	if !ok || len(leaves) == 0 {
		return nil
	}
	var out []cbParam
	for _, l := range leaves {
		p, ok := cb.paramOf(l)
		if !ok {
			return nil
		}
		out = append(out, p)
	}
	return out
}

func (cb *callbacks) paramOf(v ssa.Value) (cbParam, bool) {
	x, ok := v.(*ssa.Parameter)
	if !ok {
		return cbParam{}, false
	}
	fn := x.Parent()
	for i, p := range fn.Params {
		if p == x {
			return cbParam{fn, i}, true
		}
	}
	return cbParam{}, false
}

// sources traces a function value back to what it can be: functions, closures,
// nil and parameters, through conversions, branches, local variables and the
// free variables of closures. It reports false if any of it can't be followed
// (a field, a map, a call result).
func (cb *callbacks) sources(v ssa.Value) ([]ssa.Value, bool) {
	var out []ssa.Value
	seen := map[ssa.Value]bool{}
	var walk func(v ssa.Value, depth int) bool
	walk = func(v ssa.Value, depth int) bool {
		if depth > 32 {
			return false
		}
		if seen[v] {
			return true
		}
		seen[v] = true
		switch x := v.(type) {
		case *ssa.Function, *ssa.MakeClosure, *ssa.Parameter:
			out = append(out, v)
			return true
		case *ssa.Const:
			return x.IsNil()
		case *ssa.ChangeType:
			return walk(x.X, depth+1)
		case *ssa.Phi:
			for _, e := range x.Edges {
				if !walk(e, depth+1) {
					return false
				}
			}
			return true
		case *ssa.FreeVar:
			b, ok := cb.binding(x)
			return ok && walk(b, depth+1)
		case *ssa.UnOp:
			if x.Op != token.MUL {
				return false
			}
			vals, ok := cb.stored(x.X)
			if !ok {
				return false
			}
			for _, s := range vals {
				if !walk(s, depth+1) {
					return false
				}
			}
			return true
		}
		return false
	}
	if !walk(v, 0) {
		return nil, false
	}
	return out, true
}

// makeClosure returns the instruction that makes the anonymous function f, in
// whichever package variant (plain or test) f is.
func (cb *callbacks) makeClosure(f *ssa.Function) *ssa.MakeClosure {
	if mc, ok := cb.closure[f]; ok {
		return mc
	}
	var found *ssa.MakeClosure
	if p := f.Parent(); p != nil {
		for _, b := range p.Blocks {
			for _, in := range b.Instrs {
				if mc, ok := in.(*ssa.MakeClosure); ok && mc.Fn == f {
					found = mc
				}
			}
		}
	}
	cb.closure[f] = found
	return found
}

// binding returns the value a closure's free variable was bound to.
func (cb *callbacks) binding(fv *ssa.FreeVar) (ssa.Value, bool) {
	fn := fv.Parent()
	mc := cb.makeClosure(fn)
	if mc == nil {
		return nil, false
	}
	for i, x := range fn.FreeVars {
		if x == fv && i < len(mc.Bindings) {
			return mc.Bindings[i], true
		}
	}
	return nil, false
}

// stored returns every value stored to a local variable (an Alloc, possibly
// reached through closures' free variables), or false if its address goes
// anywhere a store couldn't be seen.
func (cb *callbacks) stored(addr ssa.Value) ([]ssa.Value, bool) {
	for {
		fv, ok := addr.(*ssa.FreeVar)
		if !ok {
			break
		}
		b, ok := cb.binding(fv)
		if !ok {
			return nil, false
		}
		addr = b
	}
	alloc, ok := addr.(*ssa.Alloc)
	if !ok {
		return nil, false // a global, a field, a slice element
	}
	var out []ssa.Value
	seen := map[ssa.Value]bool{}
	var scan func(a ssa.Value) bool
	scan = func(a ssa.Value) bool {
		if seen[a] {
			return true
		}
		seen[a] = true
		refs := a.Referrers()
		if refs == nil {
			return false
		}
		for _, r := range *refs {
			switch x := r.(type) {
			case *ssa.Store:
				if x.Addr != a {
					return false // the address itself is stored somewhere
				}
				out = append(out, x.Val)
			case *ssa.UnOp, *ssa.DebugRef:
				// loads
			case *ssa.MakeClosure:
				f := x.Fn.(*ssa.Function)
				for i, b := range x.Bindings {
					if b == a && i < len(f.FreeVars) && !scan(f.FreeVars[i]) {
						return false
					}
				}
			default:
				return false
			}
		}
		return true
	}
	if !scan(alloc) {
		return nil, false
	}
	return out, true
}

func isFunc(t types.Type) bool {
	_, ok := t.Underlying().(*types.Signature)
	return ok
}

// onlyReturned reports whether v (a closure converted to a named function
// type or an interface, as in return http.HandlerFunc(func…)) is only
// returned.
func onlyReturned(v ssa.Value) bool {
	refs := v.Referrers()
	if refs == nil || len(*refs) == 0 {
		return false
	}
	for _, r := range *refs {
		switch r.(type) {
		case *ssa.Return, *ssa.DebugRef:
		default:
			return false
		}
	}
	return true
}
