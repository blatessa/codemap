package routes

import (
	"net/http"

	"wrapped/web"
)

func Logger(w http.ResponseWriter, r *http.Request)     {}
func ReqSignIn(w http.ResponseWriter, r *http.Request)  {}
func Home(w http.ResponseWriter, r *http.Request)       {}
func ListRepos(w http.ResponseWriter, r *http.Request)  {}
func CreateRepo(w http.ResponseWriter, r *http.Request) {}
func ShowRepo(w http.ResponseWriter, r *http.Request)   {}
func EditRepo(w http.ResponseWriter, r *http.Request)   {}
func Raw(w http.ResponseWriter, r *http.Request)        {}
func Settings(w http.ResponseWriter, r *http.Request)   {}
func Ping(w http.ResponseWriter, r *http.Request)       {}
func Version(w http.ResponseWriter, r *http.Request)    {}
func Hook(w http.ResponseWriter, r *http.Request)       {}
func Issue(w http.ResponseWriter, r *http.Request)      {}

func Routes() *web.Router {
	m := web.NewRouter()
	m.Use(Logger)
	register(m)
	return m
}

func register(m *web.Router) {
	// defined here, registered inside the group it's called in
	addSettings := func() {
		m.Get("/settings", Settings)
	}
	m.Get("/", Home)
	m.Group("/repos", func() {
		m.Get("", ListRepos)
		m.Post("/new", ReqSignIn, CreateRepo)
		m.Combo("/{id}").Get(ShowRepo).Post(ReqSignIn, EditRepo)
		m.Methods("GET, HEAD", "/{id}/raw", Raw)
		addSettings()
	}, ReqSignIn)
	m.Route("/v2", func(r *web.Router) {
		r.Get("/ping", Ping)
	})
	m.Any("/hooks", Hook)

	// one closure passed to two groups
	issueRoutes := func() {
		m.Get("/{index}", Issue)
	}
	m.Group("/issues", issueRoutes)
	m.Group("/pulls", issueRoutes)
}

func APIRoutes() *web.Router {
	m := web.NewRouter()
	m.Get("/version", Version)
	return m
}
