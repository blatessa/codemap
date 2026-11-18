// Package store keeps its schema in Go: migrations applied in order at startup.
package store

import (
	"database/sql"
	"fmt"
)

// The migrations define account; this SQLite copy is ignored.
const accountSchema = `CREATE TABLE account (id INTEGER PRIMARY KEY, nickname TEXT)`

var migrations = []string{
	`
CREATE TABLE project (
	id    INTEGER PRIMARY KEY,
	owner INTEGER NOT NULL REFERENCES account(id),
	name  TEXT NOT NULL UNIQUE
);
CREATE TABLE task (
	id      INTEGER PRIMARY KEY,
	project INTEGER REFERENCES project,
	title   TEXT
);`,
	`
ALTER TABLE task ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
CREATE TABLE task2 (id INTEGER PRIMARY KEY, project INTEGER, title TEXT, done INTEGER);
DROP TABLE task;
ALTER TABLE task2 RENAME TO task;
`,
}

// One constant built from pieces.
const tagSchema = "CREATE TABLE tag (" +
	"id INTEGER PRIMARY KEY, " +
	"task INTEGER REFERENCES task(id))"

func Open(db *sql.DB) error {
	for _, m := range append(migrations, tagSchema, accountSchema) {
		if _, err := db.Exec(m); err != nil {
			return fmt.Errorf("could not create table: %w", err)
		}
	}
	return nil
}

func Titles(db *sql.DB) (*sql.Rows, error) { return db.Query("SELECT title FROM task") }
