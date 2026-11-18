package store

import (
	"errors"
	"fmt"
	"strings"
)

type DB struct{}

func (db *DB) Query(q string, args ...any) error { return nil }
func (db *DB) Exec(q string, args ...any) error  { return nil }

type Storage struct {
	db   *DB
	exec func(q string, args ...any) error // not a DB method: queries go through a func value
	log  func(msg string)
}

// EntryQueryBuilder assembles its query from fragments.
type EntryQueryBuilder struct {
	s     *Storage
	conds []string
}

func (b *EntryQueryBuilder) WithActiveUsers() *EntryQueryBuilder {
	b.conds = append(b.conds, "e.user_id IN (SELECT id FROM users WHERE active)")
	return b
}

func (b *EntryQueryBuilder) WithStars() *EntryQueryBuilder {
	// stars isn't a known table and this isn't a complete statement: ignored.
	b.conds = append(b.conds, "e.id IN (SELECT entry_id FROM stars)")
	return b
}

func (b *EntryQueryBuilder) GetEntries() error {
	query := `
		SELECT e.id, f.title
		FROM entries e
		LEFT JOIN feeds f ON f.id = e.feed_id
		WHERE %s %s`
	return b.s.db.Query(fmt.Sprintf(query, strings.Join(b.conds, " AND "), "LIMIT 10"))
}

func (b *EntryQueryBuilder) Count() error {
	var sb strings.Builder
	sb.WriteString("SELECT count(*)")
	sb.WriteString(" FROM entries e")
	sb.WriteString(" LEFT JOIN feeds f ON f.id = e.feed_id")
	return b.s.db.Query(sb.String())
}

// UpdateTitle passes a constant UPDATE through a helper that isn't a DB method.
func (s *Storage) UpdateTitle(id int, title string) error {
	return s.run(`UPDATE entries SET title=$1 WHERE id=$2`, title, id)
}

// Prune names a table no migration defines, in a complete statement.
func (s *Storage) Prune() error {
	return s.run("DELETE FROM audit_log WHERE ts < now()")
}

func (s *Storage) run(q string, args ...any) error { return s.exec(q, args...) }

// DeleteFeed is found by the DB method path; the fragment scan adds nothing.
func (s *Storage) DeleteFeed(id int) error {
	return s.db.Exec("DELETE FROM feeds WHERE id=$1", id)
}

// Cached mentions a known table in messages only.
func (s *Storage) Cached() error {
	msg := "failed to read from cache"
	s.log(msg)
	s.log("Reading from cache")
	return errors.New("SELECT FROM cache failed")
}
