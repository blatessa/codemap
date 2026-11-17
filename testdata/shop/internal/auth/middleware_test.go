package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

var okHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})

func TestRequireUser_MissingToken(t *testing.T) {
	h := newTestHandler(t)
	rec := httptest.NewRecorder()
	h.RequireUser(okHandler).ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 401 {
		t.Fatalf("got %d, want 401", rec.Code)
	}
}
