// Package app has the shapes of callback helpers the extractor must attribute
// to their callers: transactions, forwarding, wrapping, named callbacks.
package app

import "context"

// ---- helpers ----

func WithTx(ctx context.Context, f func(context.Context) error) error {
	if ctx == nil {
		return f(ctx)
	}
	return txNoCheck(ctx, f)
}

func txNoCheck(ctx context.Context, f func(context.Context) error) error {
	begin()
	return f(ctx)
}

func WithTx2[T any](ctx context.Context, f func(context.Context) (T, error)) (ret T, err error) {
	err = WithTx(ctx, func(ctx context.Context) (e error) {
		ret, e = f(ctx)
		return e
	})
	return ret, err
}

type Job func() error

func Retry(f Job) error {
	for i := 0; i < 3; i++ {
		if f() == nil {
			return nil
		}
	}
	return nil
}

// Dynamic is only ever called through a variable: its caller gets everything
// it may be passed.
func Dynamic(f func()) { f() }

var dyn = Dynamic

// RunAll calls functions from a list, not a parameter: a registry.
func RunAll(fs []func()) {
	for _, f := range fs {
		f()
	}
}

func begin() {}

// ---- callers ----

func CreateIssue(ctx context.Context) error {
	return WithTx(ctx, func(ctx context.Context) error { return insertIssue() })
}

func DeleteRepo(ctx context.Context) error {
	return WithTx(ctx, func(ctx context.Context) error { deleteRepo(); return nil })
}

func MakePR(ctx context.Context) (int, error) {
	return WithTx2(ctx, func(ctx context.Context) (int, error) { return insertPR(), nil })
}

func Sync() error { return Retry(syncMirror) }

// UpdateState keeps its callback in a local variable, set on two branches and
// in a closure, before passing it.
func UpdateState(ctx context.Context, full bool) error {
	var apply func(context.Context) error
	if full {
		apply = func(context.Context) error { return applyFull() }
	} else {
		set := func() { apply = applyPart }
		set()
	}
	return WithTx(ctx, apply)
}

func Poke() { dyn(func() { poked() }) }

func Boot() { RunAll([]func(){initA, initB}) }

// Run is a callback helper; ByName passes it something it can't trace (a map
// entry), so ByName gets everything Run was ever passed. Direct passes a named
// function and gets just that.
func Run(f func()) { f() }

var handlers = map[string]func(){"a": handlerA}

func ByName(k string) { Run(handlers[k]) }
func Direct()         { Run(handlerB) }

func insertIssue() error              { return nil }
func deleteRepo()                     {}
func insertPR() int                   { return 1 }
func syncMirror() error               { return nil }
func poked()                          {}
func applyFull() error                { return nil }
func handlerA()                       {}
func handlerB()                       {}
func applyPart(context.Context) error { return nil }
func initA()                          {}
func initB()                          {}

// ---- decorators ----

type HandlerFunc func(string) error

// Wrap returns a handler that runs h: its call of h belongs to whoever passed h.
func Wrap(h func(string) error) HandlerFunc {
	return HandlerFunc(func(s string) error {
		logged()
		return h(s)
	})
}

// Plain returns a closure without a conversion.
func Plain(h func()) func() {
	return func() { h() }
}

func logged()               {}
func showUser(string) error { return nil }
func showRepo(string) error { return nil }
func ping()                 {}

func Routes() []HandlerFunc {
	return []HandlerFunc{Wrap(showUser), Wrap(func(s string) error { return showRepo(s) })}
}

func Health() func() { return Plain(ping) }
