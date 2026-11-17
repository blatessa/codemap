package sqlext

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"codemap/internal/project"
)

func accesses(q string) string {
	var out []string
	for _, a := range Classify(q) {
		k := "r"
		if a.Write {
			k = "w"
		}
		out = append(out, k+":"+a.Table)
	}
	return fmt.Sprint(out)
}

func TestClassify(t *testing.T) {
	cases := []struct{ q, want string }{
		{`SELECT id, email FROM users WHERE id = $1`, "[r:users]"},
		{`select * from public.orders o join users u on u.id = o.user_id`, "[r:orders r:users]"},
		{`SELECT a.x FROM a, b AS bb, "Weird" WHERE a.id = bb.id`, "[r:a r:b r:Weird]"},
		{`SELECT * FROM billing.invoices`, "[r:billing.invoices]"},
		{"INSERT INTO orders (user_id, items)\n VALUES ($1, $2) RETURNING id", "[w:orders]"},
		{`INSERT INTO archive SELECT * FROM orders WHERE created_at < now()`, "[w:archive r:orders]"},
		{`INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = excluded.a`, "[w:t]"},
		{`INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE a = VALUES(a)`, "[w:t]"},
		{`INSERT  article SET title=? , content=?`, "[w:article]"},
		{`INSERT IGNORE INTO t (a) VALUES (1)`, "[w:t]"},
		{`INSERT OR REPLACE INTO t (a) VALUES (1)`, "[w:t]"},
		{`REPLACE INTO t (a) VALUES (1)`, "[w:t]"},
		{`UPDATE stock SET reserved = 0 WHERE expires_at < now()`, "[w:stock]"},
		{`UPDATE orders o SET status = s.status FROM staging s WHERE s.id = o.id`, "[w:orders r:staging]"},
		{`DELETE FROM sessions WHERE expires_at < now()`, "[w:sessions]"},
		{`DELETE FROM a USING b WHERE a.id = b.id`, "[w:a r:b]"},
		{`SELECT * FROM jobs WHERE id = $1 FOR UPDATE SKIP LOCKED`, "[r:jobs]"},
		{`SELECT EXTRACT(YEAR FROM created_at) FROM orders`, "[r:orders]"},
		{`SELECT * FROM generate_series(1, 10)`, "[]"},
		{`SELECT * FROM (SELECT id FROM users) sub JOIN orders ON true`, "[r:users r:orders]"},
		{`SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)`, "[r:users r:orders]"},
		{`WITH recent AS (SELECT * FROM orders WHERE x) SELECT * FROM recent JOIN users ON true`, "[r:orders r:users]"},
		{`WITH moved AS (DELETE FROM queue RETURNING *) INSERT INTO done SELECT * FROM moved`, "[w:queue w:done]"},
		{"-- name: GetAuthor :one\nSELECT * FROM authors WHERE id = $1 LIMIT 1", "[r:authors]"},
		{`SELECT 1`, "[]"},
		{`SELECT now()`, "[]"},
		{"SELECT * FROM `users` WHERE a = 'it''s FROM x'", "[r:users]"},
		{`MERGE INTO stock s USING incoming i ON s.sku = i.sku WHEN MATCHED THEN UPDATE SET qty = i.qty`, "[w:stock r:incoming]"},
		{`user:42`, "[]"},
		{`key`, "[]"},
		{`CREATE TABLE x (id int)`, "[]"},
	}
	for _, c := range cases {
		if got := accesses(c.q); got != c.want {
			t.Errorf("Classify(%q) = %s, want %s", c.q, got, c.want)
		}
	}
}

func TestCollapse(t *testing.T) {
	got := Collapse("UPDATE stock SET reserved = reserved + $2\n\t\t\t WHERE sku = $1")
	if want := "UPDATE stock SET reserved = reserved + $2 WHERE sku = $1"; got != want {
		t.Errorf("got %q", got)
	}
	if got := Collapse("-- name: X :one\nSELECT 1"); got != "SELECT 1" {
		t.Errorf("got %q", got)
	}
}

func cols(s *Schema, table string) string {
	t := s.Table(table)
	if t == nil {
		return "<missing>"
	}
	b, _ := json.Marshal(t.Columns)
	return string(b)
}

func TestSchema(t *testing.T) {
	s := NewSchema()
	s.Apply("1.sql", `
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          varchar(255),
  balance       numeric(10, 2) DEFAULT 0,
  seen_at       timestamp with time zone,
  tags          text[]
);
CREATE TABLE orders (
  id      bigserial,
  user_id uuid NOT NULL REFERENCES users,
  "Note"  text,
  CONSTRAINT orders_pk PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS public.audit (at timestamptz, actor uuid, FOREIGN KEY (actor) REFERENCES users (id));
CREATE TABLE legacy (id int PRIMARY KEY);
`)
	s.Apply("2.sql", `
ALTER TABLE orders ADD COLUMN charge_id text, ADD COLUMN IF NOT EXISTS user_id int;
CREATE UNIQUE INDEX CONCURRENTLY orders_charge ON orders (charge_id);
ALTER TABLE users DROP COLUMN tags;
ALTER TABLE users RENAME COLUMN name TO full_name;
ALTER TABLE users ALTER COLUMN balance TYPE bigint USING balance::bigint;
DROP TABLE IF EXISTS legacy CASCADE;
ALTER TABLE audit RENAME TO audit_log;
CREATE INDEX ON audit_log (at);
`)
	s.Apply("3.sql", `-- +goose Up
CREATE TABLE things (id int);
-- +goose Down
DROP TABLE users;
`)

	want := map[string]string{
		"users":     `[{"Name":"id","Type":"uuid","Note":"pk"},{"Name":"email","Type":"text","Note":"unique"},{"Name":"full_name","Type":"varchar(255)","Note":""},{"Name":"balance","Type":"bigint","Note":""},{"Name":"seen_at","Type":"timestamp with time zone","Note":""}]`,
		"orders":    `[{"Name":"id","Type":"bigserial","Note":"pk"},{"Name":"user_id","Type":"uuid","Note":"→ users.id"},{"Name":"Note","Type":"text","Note":""},{"Name":"charge_id","Type":"text","Note":"unique"}]`,
		"audit_log": `[{"Name":"at","Type":"timestamptz","Note":"index"},{"Name":"actor","Type":"uuid","Note":"→ users.id"}]`,
		"things":    `[{"Name":"id","Type":"int","Note":""}]`,
		"legacy":    "<missing>",
		"audit":     "<missing>",
	}
	for table, w := range want {
		if got := cols(s, table); got != w {
			t.Errorf("%s:\n got %s\nwant %s", table, got, w)
		}
	}
	if got := s.Table("orders").Sources; !reflect.DeepEqual(got, []string{"1.sql", "2.sql"}) {
		t.Errorf("orders sources = %v", got)
	}
	if got := s.Table("audit_log").Sources; !reflect.DeepEqual(got, []string{"1.sql", "2.sql"}) {
		t.Errorf("audit_log sources = %v", got)
	}
}

func TestSchemaMySQL(t *testing.T) {
	s := NewSchema()
	s.Apply("1.sql", "CREATE TABLE `posts` (\n `id` int NOT NULL AUTO_INCREMENT,\n `slug` varchar(64) NOT NULL,\n `author_id` int,\n PRIMARY KEY (`id`),\n UNIQUE KEY `slug` (`slug`),\n KEY `author` (`author_id`)\n) ENGINE=InnoDB;\nALTER TABLE posts MODIFY COLUMN slug varchar(128) NOT NULL;\nRENAME TABLE posts TO articles;")
	want := `[{"Name":"id","Type":"int","Note":"pk"},{"Name":"slug","Type":"varchar(128)","Note":""},{"Name":"author_id","Type":"int","Note":"index"}]`
	if got := cols(s, "articles"); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		pat, name string
		want      bool
	}{
		{"db/migrations/*.sql", "db/migrations/0001_init.sql", true},
		{"db/migrations/*.sql", "db/migrations/sub/0001.sql", false},
		{"**/migrations/*.sql", "migrations/1.sql", true},
		{"**/migrations/*.sql", "a/b/migrations/1.sql", true},
		{"vendor/**", "vendor", true},
		{"vendor/**", "vendor/x/y.go", true},
		{"**/*_gen.go", "internal/x/y_gen.go", true},
		{"**/*_gen.go", "y_gen.go", true},
		{"internal/legacy", "internal/legacy/", true},
	}
	for _, c := range cases {
		if got := MatchGlob(c.pat, c.name); got != c.want {
			t.Errorf("MatchGlob(%q, %q) = %v", c.pat, c.name, got)
		}
	}
}

func TestMigrationsFixture(t *testing.T) {
	g, err := Migrations("../../../testdata/shop", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Modules) != 1 || g.Modules[0].Path != "db/migrations" {
		t.Fatalf("modules = %+v", g.Modules)
	}
	var ids []string
	for _, n := range g.Nodes {
		ids = append(ids, n.ID)
	}
	if fmt.Sprint(ids) != "[table:orders table:stock table:users]" {
		t.Errorf("tables = %v", ids)
	}
}
