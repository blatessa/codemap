// Package server registers routes through helpers whose paths are built from
// their parameters.
package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
)

type Org struct{}

func (o *Org) State() any                     { return nil }
func (o *Org) CreateTask(r *http.Request) any { return nil }
func (o *Org) SetStatus(status string) any    { return nil }

type Server struct{}

func (s *Server) org(name string) *Org { return &Org{} }

// wrap adapts a JSON handler.
func (s *Server) wrap(h func(*http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, _ := h(r)
		json.NewEncoder(w).Encode(v)
	}
}

func (s *Server) Share(o *Org, r *http.Request) (any, error)    { return nil, nil }
func (s *Server) Users(w http.ResponseWriter, r *http.Request)  {}
func (s *Server) Items(w http.ResponseWriter, r *http.Request)  {}
func (s *Server) Report(w http.ResponseWriter, r *http.Request) {}
func (s *Server) Health(w http.ResponseWriter, r *http.Request) {}
func (s *Server) A(w http.ResponseWriter, r *http.Request)      {}
func (s *Server) B(w http.ResponseWriter, r *http.Request)      {}
func (s *Server) Nope(w http.ResponseWriter, r *http.Request)   {}

const apiVersion = 2

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// ply's helper: a "METHOD /path" pattern split with strings.Cut, a prefix,
	// and the handler called from inside a wrapper.
	p := func(pattern string, h func(*Org, *http.Request) (any, error)) {
		method, rest, _ := strings.Cut(pattern, " ")
		mux.HandleFunc(method+" /{org}/api"+rest, s.wrap(func(r *http.Request) (any, error) {
			return h(s.org(r.PathValue("org")), r)
		}))
	}
	p("GET /state", func(o *Org, r *http.Request) (any, error) {
		return o.State(), nil
	})
	p("POST /tasks", func(o *Org, r *http.Request) (any, error) {
		return o.CreateTask(r), nil
	})
	p("POST /tasks/{id}/share", s.Share)
	for _, st := range []struct{ path, status string }{{"ready", "r"}, {"close", "c"}} {
		p("POST /tasks/{id}/"+st.path, func(o *Org, r *http.Request) (any, error) {
			return o.SetStatus(st.status), nil
		})
	}

	// Prefix concatenation.
	v1 := func(path string, h http.HandlerFunc) {
		mux.HandleFunc("GET /v1"+path, h)
	}
	v1("/users", s.Users)
	v1(os.Getenv("EXTRA"), s.Nope) // a runtime path: no route

	// Named helpers.
	register(mux, "/shop", s.Items)
	versioned(mux, "reports", s.Report)
	health(mux, "/svc/", s.Health)
	byNumber(mux, 7, s.Nope) // the path depends on a non-string: no route

	// A table of routes.
	for _, rt := range []struct {
		path string
		h    http.HandlerFunc
	}{{"/a", s.A}, {path: "/b", h: s.B}} {
		mux.HandleFunc("GET /table"+rt.path, rt.h)
	}
	return mux
}

func register(mux *http.ServeMux, prefix string, h http.HandlerFunc) {
	mux.HandleFunc("GET "+path.Join(prefix, "items"), h)
}

func versioned(mux *http.ServeMux, name string, h http.HandlerFunc) {
	mux.HandleFunc(fmt.Sprintf("GET /api/v%d/%s", apiVersion, name), h)
}

func health(mux *http.ServeMux, prefix string, h http.HandlerFunc) {
	base := strings.TrimSuffix(prefix, "/")
	mux.HandleFunc("GET "+base+"/health", h)
}

func byNumber(mux *http.ServeMux, n int, h http.HandlerFunc) {
	mux.HandleFunc("GET /n/"+strconv.Itoa(n), h)
}
