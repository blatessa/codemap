// Package chi is a signature-only stand-in for github.com/go-chi/chi/v5.
package chi

import "net/http"

type Middlewares []func(http.Handler) http.Handler

type Router interface {
	http.Handler
	Use(middlewares ...func(http.Handler) http.Handler)
	With(middlewares ...func(http.Handler) http.Handler) Router
	Group(fn func(r Router)) Router
	Route(pattern string, fn func(r Router)) Router
	Mount(pattern string, h http.Handler)
	Handle(pattern string, h http.Handler)
	HandleFunc(pattern string, h http.HandlerFunc)
	Method(method, pattern string, h http.Handler)
	MethodFunc(method, pattern string, h http.HandlerFunc)
	Get(pattern string, h http.HandlerFunc)
	Post(pattern string, h http.HandlerFunc)
	Put(pattern string, h http.HandlerFunc)
	Delete(pattern string, h http.HandlerFunc)
}

type Mux struct{ Router }

func NewRouter() *Mux { return &Mux{} }
