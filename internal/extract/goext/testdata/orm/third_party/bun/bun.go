package bun

import "context"

type BaseModel struct{}
type DB struct{}
type SelectQuery struct{}
type InsertQuery struct{}

func (*DB) NewSelect() *SelectQuery                                     { return nil }
func (*DB) NewInsert() *InsertQuery                                     { return nil }
func (*SelectQuery) Model(m any) *SelectQuery                           { return nil }
func (*SelectQuery) Where(q string, args ...any) *SelectQuery           { return nil }
func (*SelectQuery) Scan(ctx context.Context, dest ...any) error        { return nil }
func (*InsertQuery) Model(m any) *InsertQuery                           { return nil }
func (*InsertQuery) Exec(ctx context.Context, dest ...any) (int, error) { return 0, nil }
