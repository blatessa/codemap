//go:build js && wasm

// Command codemap-wasm is the viewer's copy of codemap's graph walks
// (internal/wasm). It sets globalThis.codemap to an object with:
//
//	load(graphJSON) → handle      free(handle)
//	trace(handle, id) → JSON      up(handle, id) → JSON
//	entries(handle, id) → JSON    tests(handle, idsJSON) → JSON
//	effects(handle, id) → JSON
//
// Errors are thrown as JavaScript errors.
package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/blatessa/codemap/internal/wasm"
)

func main() {
	loaded := map[int]*wasm.Loaded{}
	next := 0
	get := func(v js.Value) *wasm.Loaded {
		l := loaded[v.Int()]
		if l == nil {
			panic(js.Global().Get("Error").New("codemap: unknown graph handle"))
		}
		return l
	}
	reply := func(v any) any {
		b, err := json.Marshal(v)
		if err != nil {
			panic(js.Global().Get("Error").New(err.Error()))
		}
		return string(b)
	}
	fn := func(f func(a []js.Value) any) js.Func {
		return js.FuncOf(func(_ js.Value, a []js.Value) any { return f(a) })
	}
	api := map[string]any{
		"load": fn(func(a []js.Value) any {
			l, err := wasm.Load([]byte(a[0].String()))
			if err != nil {
				panic(js.Global().Get("Error").New("codemap: " + err.Error()))
			}
			next++
			loaded[next] = l
			return next
		}),
		"free":    fn(func(a []js.Value) any { delete(loaded, a[0].Int()); return nil }),
		"trace":   fn(func(a []js.Value) any { return reply(get(a[0]).Trace(a[1].String())) }),
		"up":      fn(func(a []js.Value) any { return reply(get(a[0]).Up(a[1].String())) }),
		"entries": fn(func(a []js.Value) any { return reply(get(a[0]).Entries(a[1].String())) }),
		"effects": fn(func(a []js.Value) any { return reply(get(a[0]).Effects(a[1].String())) }),
		"tests": fn(func(a []js.Value) any {
			var ids []string
			if err := json.Unmarshal([]byte(a[1].String()), &ids); err != nil {
				panic(js.Global().Get("Error").New("codemap: " + err.Error()))
			}
			return reply(get(a[0]).Tests(ids))
		}),
	}
	js.Global().Set("codemap", js.ValueOf(api))
	select {}
}
