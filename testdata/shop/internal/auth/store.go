// Package auth handles login and the RequireUser middleware.
package auth

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

// User is a signed-in user.
type User struct {
	ID           string
	Email        string
	PasswordHash []byte
}

type ctxKey struct{}

func withUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, ctxKey{}, u)
}

// CurrentUser returns the user RequireUser put on the request.
func CurrentUser(r *http.Request) *User {
	u, _ := r.Context().Value(ctxKey{}).(*User)
	return u
}

// Store loads users.
type Store struct{ db *pgxpool.Pool }

// NewStore returns a store on db.
func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

// UserByID loads a user.
func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	var u User
	err := s.db.QueryRow(ctx, `SELECT id, email FROM users WHERE id = $1`, id).Scan(&u.ID, &u.Email)
	if err != nil {
		return nil, err
	}
	return &u, nil
}
