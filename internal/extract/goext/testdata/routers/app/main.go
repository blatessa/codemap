// Command app registers routes with every supported router, for goext's tests.
package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/mux"
	"github.com/labstack/echo/v4"
)

type Handlers struct{}

func (h *Handlers) Health(w http.ResponseWriter, r *http.Request)     {}
func (h *Handlers) ListOrders(w http.ResponseWriter, r *http.Request) {}
func (h *Handlers) Refund(w http.ResponseWriter, r *http.Request)     {}
func (h *Handlers) Items(w http.ResponseWriter, r *http.Request)      {}
func (h *Handlers) DeleteUser(w http.ResponseWriter, r *http.Request) {}
func (h *Handlers) Ping(w http.ResponseWriter, r *http.Request)       {}
func (h *Handlers) Helper()                                           {}
func (h *Handlers) Product(w http.ResponseWriter, r *http.Request)    {}
func (h *Handlers) Carts(w http.ResponseWriter, r *http.Request)      {}
func (h *Handlers) Legacy(w http.ResponseWriter, r *http.Request)     {}
func (h *Handlers) Files(w http.ResponseWriter, r *http.Request)      {}
func (h *Handlers) Hook(w http.ResponseWriter, r *http.Request)       {}
func (h *Handlers) Default(w http.ResponseWriter, r *http.Request)    {}
func (h *Handlers) GinUser(c *gin.Context)                            {}
func (h *Handlers) GinCreate(c *gin.Context)                          {}
func (h *Handlers) GinThing(c *gin.Context)                           {}
func (h *Handlers) EchoStats(c echo.Context) error                    { return nil }
func (h *Handlers) EchoSearch(c echo.Context) error                   { return nil }

func Logger(next http.Handler) http.Handler   { return next }
func Auth(next http.Handler) http.Handler     { return next }
func Audit(next http.Handler) http.Handler    { return next }
func Admin(next http.Handler) http.Handler    { return next }
func MuxLog(next http.Handler) http.Handler   { return next }
func withAuth(next http.Handler) http.Handler { return next }

func GinAuth(c *gin.Context) {}
func GinRate(c *gin.Context) {}
func GinLate(c *gin.Context) {}

func EchoLog(next echo.HandlerFunc) echo.HandlerFunc   { return next }
func EchoAuth(next echo.HandlerFunc) echo.HandlerFunc  { return next }
func EchoCache(next echo.HandlerFunc) echo.HandlerFunc { return next }
func EchoLate(next echo.HandlerFunc) echo.HandlerFunc  { return next }

// chi: a router in a struct field, Route/Group/With/Mount, a named callback and
// an inline handler.

type Server struct {
	router chi.Router
	h      *Handlers
}

func NewServer(h *Handlers) *Server {
	s := &Server{router: chi.NewRouter(), h: h}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.router.Use(Logger)
	s.router.Get("/health", s.h.Health)
	s.router.Route("/orders", func(r chi.Router) {
		r.Use(Auth)
		r.Get("/", s.h.ListOrders)
		r.With(Audit).Post("/{id}/refund", s.h.Refund)
		r.Route("/{id}", s.h.orderRoutes)
	})
	s.router.Group(func(r chi.Router) {
		r.Use(Admin)
		r.Delete("/admin/users/{id}", s.h.DeleteUser)
	})
	s.router.Mount("/api", apiRouter(s.h))
	s.router.Get("/inline", func(w http.ResponseWriter, r *http.Request) { s.h.Helper() })
}

func (h *Handlers) orderRoutes(r chi.Router) { r.Get("/items", h.Items) }

func apiRouter(h *Handlers) chi.Router {
	r := chi.NewRouter()
	r.Get("/v1/ping", h.Ping)
	return r
}

// gin: groups with middleware, a group passed to another function.

func ginRoutes(h *Handlers) *gin.Engine {
	r := gin.Default()
	api := r.Group("/api/v2", GinAuth)
	registerUsers(api.Group("/users"), h)
	r.Handle("PUT", "/things/:id", h.GinThing)
	// gin copies middleware when a group or route is created: GinLate doesn't
	// apply to the routes above.
	r.Use(GinLate)
	r.GET("/late", h.GinThing)
	return r
}

func registerUsers(g *gin.RouterGroup, h *Handlers) {
	g.GET("/:id", GinRate, h.GinUser)
	g.POST("", h.GinCreate)
}

// echo: route-level and group middleware, Match.

func echoRoutes(h *Handlers) {
	e := echo.New()
	e.Use(EchoLog)
	g := e.Group("/admin", EchoAuth)
	g.GET("/stats", h.EchoStats, EchoCache)
	e.Match([]string{"GET", "POST"}, "/search", h.EchoSearch)
	// echo's root middleware runs for every route, whenever it was added.
	e.Use(EchoLate)
}

// gorilla/mux: Methods chains, sub-routers, Path(…).HandlerFunc.

func muxRoutes(h *Handlers) http.Handler {
	r := mux.NewRouter()
	r.Use(MuxLog)
	r.HandleFunc("/products/{id:[0-9]+}", h.Product).Methods("GET", "PUT")
	s := r.PathPrefix("/v3").Subrouter()
	s.HandleFunc("/carts", h.Carts).Methods("POST").Name("carts")
	r.Path("/legacy").Methods("GET").HandlerFunc(h.Legacy)
	return r
}

// net/http: Go 1.22 patterns, hosts, {$}, wrapped handlers, DefaultServeMux.

func stdRoutes(h *Handlers) http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /files/{path...}", h.Files)
	m.Handle("POST example.com/hooks/{$}", withAuth(http.HandlerFunc(h.Hook)))
	http.HandleFunc("/default", h.Default)
	return m
}

func main() {
	h := &Handlers{}
	NewServer(h)
	ginRoutes(h)
	echoRoutes(h)
	muxRoutes(h)
	stdRoutes(h)
}
