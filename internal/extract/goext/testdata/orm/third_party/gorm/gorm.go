package gorm

import "time"

type Model struct {
	ID        uint `gorm:"primarykey"`
	CreatedAt time.Time
}

type DB struct{}

func (*DB) Model(v any) *DB                  { return nil }
func (*DB) Table(name string) *DB            { return nil }
func (*DB) Where(q any, args ...any) *DB     { return nil }
func (*DB) First(dest any, conds ...any) *DB { return nil }
func (*DB) Find(dest any, conds ...any) *DB  { return nil }
func (*DB) Create(v any) *DB                 { return nil }
func (*DB) Updates(v any) *DB                { return nil }
func (*DB) Scan(dest any) *DB                { return nil }
