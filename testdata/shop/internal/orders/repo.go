package orders

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Repo stores orders.
type Repo struct{ db *pgxpool.Pool }

// NewRepo returns a repo on db.
func NewRepo(db *pgxpool.Pool) *Repo { return &Repo{db: db} }

// Insert saves a new order and sets its ID.
func (r *Repo) Insert(ctx context.Context, o *Order) error {
	return r.db.QueryRow(ctx,
		`INSERT INTO orders (user_id, items, charge_id, status)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		o.UserID, o.Items, o.ChargeID, o.Status,
	).Scan(&o.ID)
}

// Find loads an order by ID.
func (r *Repo) Find(ctx context.Context, id string) (*Order, error) {
	var o Order
	err := r.db.QueryRow(ctx, `SELECT * FROM orders WHERE id = $1`, id).Scan(&o)
	return &o, err
}

// UpdateStatus looks the order up by Stripe charge ID, not order ID.
func (r *Repo) UpdateStatus(ctx context.Context, chargeID, status string) (*Order, error) {
	var o Order
	err := r.db.QueryRow(ctx,
		`UPDATE orders SET status = $2 WHERE charge_id = $1 RETURNING *`,
		chargeID, status,
	).Scan(&o)
	return &o, err
}
