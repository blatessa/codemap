package main

import (
	"net/http"

	"wrapped/routes"
	"wrapped/web"
)

func main() {
	r := web.NewRouter()
	r.Mount("/", routes.Routes())
	r.Mount("/api/v1", routes.APIRoutes())
	_ = http.ListenAndServe(":8080", r)
}
