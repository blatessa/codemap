package main

import "testing"

func TestSetFrontmatter(t *testing.T) {
	in := `+++
name = "Refunds"   # keep me
status = "open"
# a comment
nodes_note = "x = y"

[[node]]
id = "new:x"
links = [{label = "Docs", url = "https://x"}]
status = "untouched: not top level"
+++
## Why
Body.
`
	want := `+++
name = "Refunds"   # keep me
status = 'archived'
# a comment
nodes_note = "x = y"
pr = '#91'

[[node]]
id = "new:x"
links = [{label = "Docs", url = "https://x"}]
status = "untouched: not top level"
+++
## Why
Body.
`
	got, err := setFrontmatter([]byte(in), [][2]string{{"status", "archived"}, {"pr", "#91"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Errorf("got\n%s", got)
	}

	// A multi-line value we can't edit line by line is refused, so the caller re-marshals.
	odd := "+++\nname = \"\"\"\nstatus = 'open'\n\"\"\"\n+++\n"
	if _, err := setFrontmatter([]byte(odd), [][2]string{{"status", "archived"}}); err == nil {
		t.Error("want an error for a multi-line string")
	}
	if _, err := setFrontmatter([]byte("# no frontmatter\n"), [][2]string{{"status", "archived"}}); err == nil {
		t.Error("want an error without frontmatter")
	}
}
