// Package pgconn is a minimal stand-in.
package pgconn

// CommandTag reports how many rows a statement affected.
type CommandTag struct{ rows int64 }

// RowsAffected returns the number of affected rows. The stub always reports 0.
func (c CommandTag) RowsAffected() int64 { return c.rows }
