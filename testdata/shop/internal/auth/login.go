package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler serves the auth routes.
type Handler struct {
	db     *pgxpool.Pool
	store  *Store
	secret []byte
}

// NewHandler returns a handler.
func NewHandler(db *pgxpool.Pool, secret []byte) *Handler {
	return &Handler{db: db, store: NewStore(db), secret: secret}
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// Login checks a password and returns a token.
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	u, err := h.checkPassword(r.Context(), req.Email, req.Password)
	if err != nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": h.issueToken(u)})
}

func (h *Handler) checkPassword(ctx context.Context, email, pw string) (*User, error) {
	var u User
	err := h.db.QueryRow(ctx,
		`SELECT id, password_hash FROM users WHERE email = $1`, email,
	).Scan(&u.ID, &u.PasswordHash)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(pw))
	if len(u.PasswordHash) == 0 || subtle.ConstantTimeCompare(sum[:], u.PasswordHash) != 1 {
		return nil, errors.New("wrong password")
	}
	return &u, nil
}
