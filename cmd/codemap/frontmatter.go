package main

import (
	"errors"
	"fmt"
	"strings"

	"codemap/internal/project"
)

// setFrontmatter sets top-level string keys in a proposal file's TOML
// frontmatter, keeping the rest of the file as written (comments, inline tables
// and the body are untouched). An existing "key = ..." line is replaced; a new
// key goes after the last top-level key, before the first table. The result is
// parsed again, and any surprise (a multi-line value, say) is an error, so the
// caller falls back to re-marshalling the whole file.
func setFrontmatter(file []byte, set [][2]string) ([]byte, error) {
	fm, body, ok, err := project.SplitFrontmatter(string(file))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("no frontmatter")
	}
	lines := strings.SplitAfter(fm, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	top := len(lines) // index of the first table header
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "[") {
			top = i
			break
		}
	}
	for _, kv := range set {
		val, err := project.MarshalTOML(map[string]string{kv[0]: kv[1]})
		if err != nil {
			return nil, err
		}
		line := string(val)
		found := false
		for i := 0; i < top; i++ {
			k, _, isKV := strings.Cut(lines[i], "=")
			if isKV && strings.TrimSpace(k) == kv[0] {
				lines[i] = line
				found = true
			}
		}
		if !found {
			at := 0
			for i := 0; i < top; i++ {
				if t := strings.TrimSpace(lines[i]); t != "" && !strings.HasPrefix(t, "#") {
					at = i + 1
				}
			}
			lines = append(lines[:at], append([]string{line}, lines[at:]...)...)
			top++
		}
	}
	newFM := strings.Join(lines, "")
	var check map[string]any
	if err := project.UnmarshalTOML([]byte(newFM), &check); err != nil {
		return nil, err
	}
	for _, kv := range set {
		if check[kv[0]] != kv[1] {
			return nil, fmt.Errorf("could not set %s in place", kv[0])
		}
	}
	d := project.FrontmatterDelim + "\n"
	return []byte(d + newFM + d + body), nil
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
