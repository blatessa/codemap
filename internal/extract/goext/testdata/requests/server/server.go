// Package server serves a per-tenant JSON API.
package server

import "net/http"

func Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{tenant}/api/tasks", ListTasks)
	mux.HandleFunc("POST /{tenant}/api/tasks", CreateTask)
	mux.HandleFunc("GET /{tenant}/api/tasks/{id}", GetTask)
	mux.HandleFunc("POST /{tenant}/api/tasks/{id}/approve", Approve)
	mux.HandleFunc("POST /{tenant}/api/tasks/{id}/{action}", SetStatus)
	mux.HandleFunc("GET /{tenant}/api/users", Users)
	mux.HandleFunc("GET /{tenant}/api/users/me", Me)
	mux.HandleFunc("GET /{tenant}/api/users/{name}", User)
	mux.HandleFunc("/healthz", Health)
	return mux
}

func ListTasks(w http.ResponseWriter, r *http.Request)  {}
func CreateTask(w http.ResponseWriter, r *http.Request) {}
func GetTask(w http.ResponseWriter, r *http.Request)    {}
func Approve(w http.ResponseWriter, r *http.Request)    {}
func SetStatus(w http.ResponseWriter, r *http.Request)  {}
func Users(w http.ResponseWriter, r *http.Request)      {}
func Me(w http.ResponseWriter, r *http.Request)         {}
func User(w http.ResponseWriter, r *http.Request)       {}
func Health(w http.ResponseWriter, r *http.Request)     {}
