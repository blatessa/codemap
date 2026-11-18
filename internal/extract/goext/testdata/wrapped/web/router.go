// Package web wraps chi the way many repos do: handlers and middleware as
// variadic arguments, groups that push a prefix while a callback runs, and
// route builders.
package web

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

type Router struct {
	chi    chi.Router
	prefix string
	mw     []any
}

func NewRouter() *Router { return &Router{chi: chi.NewRouter()} }

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) { r.chi.ServeHTTP(w, req) }

func (r *Router) Use(mw ...any) { r.mw = append(r.mw, mw...) }

func (r *Router) Group(pattern string, fn func(), mw ...any) {
	prev, prevMW := r.prefix, r.mw
	r.prefix += pattern
	r.mw = append(r.mw, mw...)
	fn()
	r.prefix, r.mw = prev, prevMW
}

// Route passes the router to the callback instead.
func (r *Router) Route(pattern string, fn func(r *Router)) {
	prev := r.prefix
	r.prefix += pattern
	fn(r)
	r.prefix = prev
}

func (r *Router) Methods(methods, pattern string, h ...any) {
	for _, m := range strings.Split(methods, ",") {
		r.chi.MethodFunc(strings.TrimSpace(m), r.prefix+pattern, toHandler(h))
	}
}

func (r *Router) Get(pattern string, h ...any)  { r.Methods("GET", pattern, h...) }
func (r *Router) Post(pattern string, h ...any) { r.Methods("POST", pattern, h...) }
func (r *Router) Any(pattern string, h ...any)  { r.chi.HandleFunc(r.prefix+pattern, toHandler(h)) }

func (r *Router) Mount(pattern string, sub *Router) { r.chi.Mount(r.prefix+pattern, sub.chi) }

func (r *Router) Combo(pattern string, h ...any) *Combo { return &Combo{r: r, pattern: pattern, h: h} }

// Combo registers several methods on one path.
type Combo struct {
	r       *Router
	pattern string
	h       []any
}

func (c *Combo) Get(h ...any) *Combo  { c.r.Get(c.pattern, append(c.h, h...)...); return c }
func (c *Combo) Post(h ...any) *Combo { c.r.Post(c.pattern, append(c.h, h...)...); return c }

func toHandler(h []any) http.HandlerFunc { return nil }
