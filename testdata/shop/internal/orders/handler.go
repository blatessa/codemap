package orders

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"shop/internal/auth"
	"shop/internal/inventory"
)

// Handler serves the order routes.
type Handler struct {
	svc  *Service
	repo *Repo
}

// NewHandler returns a handler.
func NewHandler(svc *Service, repo *Repo) *Handler { return &Handler{svc: svc, repo: repo} }

// Create places an order for the signed-in user.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	var req CreateOrder
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	o, err := h.svc.Place(r.Context(), auth.CurrentUser(r), req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, o)
}

// Get returns one order.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	o, err := h.repo.Find(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, o)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	if errors.As(err, new(inventory.ErrOutOfStock)) {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	http.Error(w, "internal error", http.StatusInternalServerError)
}
