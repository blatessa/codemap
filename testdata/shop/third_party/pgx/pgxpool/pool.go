// Package pgxpool is a minimal stand-in. Queries do nothing: Scan leaves its
// destinations unchanged and Exec affects no rows.
package pgxpool

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Pool is a connection pool.
type Pool struct{}

// New opens a pool.
func New(ctx context.Context, connString string) (*Pool, error) { return &Pool{}, nil }

type row struct{}

func (row) Scan(dest ...any) error { return nil }

// QueryRow runs a query that returns one row.
func (p *Pool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row { return row{} }

// Exec runs a statement.
func (p *Pool) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
