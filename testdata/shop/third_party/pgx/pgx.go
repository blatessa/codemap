// Package pgx is a minimal stand-in for github.com/jackc/pgx/v5 used by the fixture.
package pgx

// Row is a single query result.
type Row interface {
	Scan(dest ...any) error
}
