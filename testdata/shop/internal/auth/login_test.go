package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	return NewHandler(&pgxpool.Pool{}, []byte("test-secret"))
}

func post(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest("POST", "/", strings.NewReader(body)))
	return rec
}

func TestLogin_WrongPassword(t *testing.T) {
	h := newTestHandler(t)
	rec := post(h.Login, `{"email":"a@b.c","password":"nope"}`)
	if rec.Code != 401 {
		t.Fatalf("got %d, want 401", rec.Code)
	}
}
