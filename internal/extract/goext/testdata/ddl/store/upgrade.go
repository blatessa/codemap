package store

// Applied after schema.go's DDL: files are read in path order.
const upgrade = `ALTER TABLE project ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`
