package project

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Proposal is one .codemap/proposals/<slug>.md file: YAML frontmatter holding the
// sketch, then a Markdown body (PLAN.md §6). Proposals are sketches; nothing checks
// them against the code.
type Proposal struct {
	Slug    string           `yaml:"-" json:"slug"`
	Name    string           `yaml:"name" json:"name"`
	Status  string           `yaml:"status" json:"status"` // open | archived
	Base    string           `yaml:"base,omitempty" json:"base,omitempty"`
	PR      string           `yaml:"pr,omitempty" json:"pr,omitempty"`
	Updated string           `yaml:"updated,omitempty" json:"updated,omitempty"`
	Modules []map[string]any `yaml:"modules,omitempty" json:"modules,omitempty"`
	Nodes   []map[string]any `yaml:"nodes,omitempty" json:"nodes,omitempty"`
	Edges   []map[string]any `yaml:"edges,omitempty" json:"edges,omitempty"`
	Body    string           `yaml:"-" json:"body"`
}

// ParseProposal parses a proposal file. A file without frontmatter is treated as
// an open proposal whose body is the whole file and whose name is its first heading.
func ParseProposal(b []byte) (*Proposal, error) {
	p := &Proposal{Status: "open"}
	s := string(b)
	if strings.HasPrefix(s, "---\n") || strings.HasPrefix(s, "---\r\n") {
		rest := s[strings.Index(s, "\n")+1:]
		end := strings.Index(rest, "\n---")
		if end < 0 {
			return nil, fmt.Errorf("frontmatter is not closed with ---")
		}
		if err := yaml.Unmarshal([]byte(rest[:end]), p); err != nil {
			return nil, fmt.Errorf("frontmatter: %w", err)
		}
		body := rest[end+len("\n---"):]
		body = strings.TrimPrefix(strings.TrimPrefix(body, "\r"), "\n")
		p.Body = body
	} else {
		p.Body = s
	}
	if p.Status == "" {
		p.Status = "open"
	}
	if p.Name == "" {
		if m := firstHeading.FindStringSubmatch(p.Body); m != nil {
			p.Name = strings.TrimSpace(m[1])
		}
	}
	return p, nil
}

var firstHeading = regexp.MustCompile(`(?m)^#+\s+(.+)$`)

// Marshal renders the proposal back to its file form.
func (p *Proposal) Marshal() ([]byte, error) {
	fm, err := MarshalYAML(p)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.WriteString("---\n")
	buf.Write(fm)
	buf.WriteString("---\n")
	buf.WriteString(p.Body)
	if !strings.HasSuffix(p.Body, "\n") {
		buf.WriteByte('\n')
	}
	return buf.Bytes(), nil
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify makes a file-name slug from a proposal name.
func Slugify(name string) string {
	s := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if s == "" {
		return "proposal"
	}
	return s
}
