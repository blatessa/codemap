// Package mux is a signature-only stand-in for github.com/gorilla/mux.
package mux

import "net/http"

type MiddlewareFunc func(http.Handler) http.Handler

type Router struct{}

func NewRouter() *Router { return &Router{} }

func (r *Router) HandleFunc(path string, f func(http.ResponseWriter, *http.Request)) *Route {
	return nil
}
func (r *Router) Handle(path string, h http.Handler) *Route    { return nil }
func (r *Router) PathPrefix(tpl string) *Route                 { return nil }
func (r *Router) Path(tpl string) *Route                       { return nil }
func (r *Router) Use(mwf ...MiddlewareFunc)                    {}
func (r *Router) ServeHTTP(http.ResponseWriter, *http.Request) {}

type Route struct{}

func (r *Route) Methods(methods ...string) *Route                              { return r }
func (r *Route) Name(name string) *Route                                       { return r }
func (r *Route) Subrouter() *Router                                            { return nil }
func (r *Route) HandlerFunc(f func(http.ResponseWriter, *http.Request)) *Route { return r }
func (r *Route) Handler(h http.Handler) *Route                                 { return r }
