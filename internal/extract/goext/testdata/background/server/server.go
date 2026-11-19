// Package server serves the API.
package server

import (
	"net/http"
	"time"
)

func Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/items", ListItems)
	return mux
}

// ListItems starts a ticker goroutine per request: not a job.
func ListItems(w http.ResponseWriter, r *http.Request) {
	go func() {
		t := time.NewTicker(time.Second)
		for range t.C {
			keepAlive()
		}
	}()
}

func keepAlive() {}
