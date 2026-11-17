module routers

go 1.23

require (
	github.com/gin-gonic/gin v1.0.0
	github.com/go-chi/chi/v5 v5.0.0
	github.com/gorilla/mux v1.0.0
	github.com/labstack/echo/v4 v4.0.0
)

// Signature-only stand-ins for the router libraries, so the test runs offline.
replace (
	github.com/gin-gonic/gin => ./third_party/gin
	github.com/go-chi/chi/v5 => ./third_party/chi
	github.com/gorilla/mux => ./third_party/mux
	github.com/labstack/echo/v4 => ./third_party/echo
)
