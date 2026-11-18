package sqlext

import (
	"fmt"
	"testing"
)

func TestSystemTable(t *testing.T) {
	for name, want := range map[string]bool{
		"pg_class": true, "sqlite_master": true, "information_schema.columns": true, "sys.indexes": true,
		"users": false, "pages": false, "system_settings": false,
	} {
		if SystemTable(name) != want {
			t.Errorf("SystemTable(%q) = %v", name, !want)
		}
	}
}

func TestClassifyFragment(t *testing.T) {
	cases := []struct{ s, want string }{
		// complete statements (S = trusted on their own)
		{`SELECT id FROM users WHERE id = $1`, "S[r:users]"},
		{`select id from users`, "[r:users]"},
		{"\n\t\tSELECT e.id, f.title\n\t\tFROM entries e\n\t\tLEFT JOIN feeds f ON f.id = e.feed_id\n\t\tWHERE %s %s", "S[r:entries r:feeds]"},
		{`UPDATE entries SET title=$1, content=$2 WHERE id=$3`, "S[w:entries]"},
		{`INSERT INTO entries (title) VALUES ($1)`, "S[w:entries]"},
		{`DELETE FROM sessions WHERE id = $1`, "S[w:sessions]"},
		{`WITH recent AS (SELECT * FROM orders) `, "S[r:orders]"},
		// fragments
		{` FROM entries e `, "[r:entries]"},
		{"FROM entries e\n LEFT JOIN feeds f ON f.id = e.feed_id\n INNER JOIN users u ON u.id = e.user_id", "[r:entries r:feeds r:users]"},
		{` LEFT JOIN feed_icons fi ON fi.feed_id = f.id`, "[r:feed_icons]"},
		{` RIGHT OUTER JOIN a ON true FULL JOIN b USING (id) CROSS JOIN c`, "[r:a r:b r:c]"},
		{` FROM a, b AS bb, c WHERE a.id = bb.id`, "[r:a r:b r:c]"},
		{` FROM public.orders o`, "[r:orders]"},
		{` FROM billing.invoices %s`, "[r:billing.invoices]"},
		{` WHERE e.id IN (SELECT entry_id FROM enclosures WHERE x)`, "[r:enclosures]"},
		{`AND NOT EXISTS (SELECT 1 FROM entry_tombstones t WHERE t.id = e.id)`, "[r:entry_tombstones]"},
		{`where id in (select id from users)`, "[r:users]"},
		{`UPDATE entries SET `, "S[w:entries]"},
		{`UPDATE entries e SET status=$1`, "S[w:entries]"},
		{`INSERT INTO entries (a, b)`, "S[w:entries]"},
		{`, b) UPSERT INTO kv (k) VALUES`, "[w:kv]"},
		{`DELETE FROM entries `, "S[w:entries]"},
		{` ORDER BY EXTRACT(YEAR FROM created_at)`, "[]"},
		{` WHERE a IS DISTINCT FROM b`, "[]"},
		// negatives: prose, messages, paths, log lines
		{`failed to read from cache`, "[]"},
		{`Failed to read FROM cache`, "[]"},
		{`could not fetch entries from feed %d: %w`, "[]"},
		{`reading from the user`, "[]"},
		{`Received request from client`, "[]"},
		{`[Storage:UpdateEntry] unable to update entry: %v`, "[]"},
		{`level=info msg="Entry removed from feed" feed_id=%d`, "[]"},
		{`/v1/feeds/from/entries`, "[]"},
		{`https://example.com/select?from=users`, "[]"},
		{`select a file from the list`, "[r:the]"}, // not a statement: kept only if "the" is a known table
		{`Select a file from the list`, "[r:the]"},
		{`Copy FROM source`, "[r:source]"},
		{`FROM`, "[]"},
		{`update the status`, "[]"},
		{`UPDATE the status`, "[w:the]"}, // no SET: not trusted as a statement
		{`Join our community`, "[]"},
	}
	for _, c := range cases {
		f := ClassifyFragment(c.s)
		var out []string
		for _, a := range f.Accesses {
			k := "r"
			if a.Write {
				k = "w"
			}
			out = append(out, k+":"+a.Table)
		}
		got := fmt.Sprint(out)
		if f.Statement {
			got = "S" + got
		}
		if got != c.want {
			t.Errorf("ClassifyFragment(%q) = %s, want %s", c.s, got, c.want)
		}
	}
}
