package main

import (
	"codemap/internal/project"
)

// setFrontmatter sets top-level string keys in a proposal file's frontmatter in
// place (project.SetFrontmatter). On an error the caller re-marshals the file.
func setFrontmatter(file []byte, set [][2]string) ([]byte, error) {
	return project.SetFrontmatter(file, set)
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
