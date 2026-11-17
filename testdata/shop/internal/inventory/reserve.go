// Package inventory tracks stock and reservations for items in open carts.
package inventory

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Item is a quantity of one SKU.
type Item struct {
	SKU   string `json:"sku"`
	Qty   int    `json:"qty"`
	Price int64  `json:"price"`
}

// ErrOutOfStock reports a SKU that can't be reserved.
type ErrOutOfStock struct{ SKU string }

func (e ErrOutOfStock) Error() string { return fmt.Sprintf("out of stock: %s", e.SKU) }

// Store reads and reserves stock.
type Store struct{ db *pgxpool.Pool }

// NewStore returns a store on db.
func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

// Reserve holds stock for each item and fails with ErrOutOfStock if any item is short.
// Not transactional: earlier items stay reserved if a later one fails.
func (s *Store) Reserve(ctx context.Context, items []Item) error {
	for _, it := range items {
		tag, err := s.db.Exec(ctx,
			`UPDATE stock SET reserved = reserved + $2
			 WHERE sku = $1 AND on_hand - reserved >= $2`,
			it.SKU, it.Qty)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrOutOfStock{SKU: it.SKU}
		}
	}
	return nil
}

// ReleaseExpired clears reservations whose carts have expired.
func (s *Store) ReleaseExpired(ctx context.Context) error {
	_, err := s.db.Exec(ctx,
		`UPDATE stock SET reserved = 0 WHERE expires_at < now()`)
	return err
}
