package project

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
)

// Proposal is one .codemap/proposals/<slug>.md file: TOML frontmatter between +++ lines holding the
// sketch, then a Markdown body (format: skills/codemap/reference/proposals.md). Proposals are sketches; nothing checks
// them against the code.
type Proposal struct {
	Slug    string           `toml:"-" json:"slug"`
	Name    string           `toml:"name" json:"name"`
	Status  string           `toml:"status" json:"status"` // open | archived
	Base    string           `toml:"base,omitempty" json:"base,omitempty"`
	PR      string           `toml:"pr,omitempty" json:"pr,omitempty"`
	Updated string           `toml:"updated,omitempty" json:"updated,omitempty"`
	Modules []map[string]any `toml:"module,omitempty" json:"modules,omitempty"`
	Nodes   []map[string]any `toml:"node,omitempty" json:"nodes,omitempty"`
	Edges   []map[string]any `toml:"edge,omitempty" json:"edges,omitempty"`
	Notes   []Note           `toml:"note,omitempty" json:"notes,omitempty"`
	Body    string           `toml:"-" json:"body"`
}

// Note is something the author wants an agent to know that the sketch can't
// say: pinned to a node (On), to lines of code (File, From, To, with the Quote
// as it was read), or to nothing but the proposal. Text is Markdown.
type Note struct {
	On    string `toml:"on,omitempty" json:"on,omitempty"`
	File  string `toml:"file,omitempty" json:"file,omitempty"`
	From  int    `toml:"from,omitempty" json:"from,omitempty"`
	To    int    `toml:"to,omitempty" json:"to,omitempty"`
	Quote string `toml:"quote,omitempty" json:"quote,omitempty"`
	Text  string `toml:"text" json:"text"`
}

// ParseProposal parses a proposal file. A file without frontmatter is treated as
// an open proposal whose body is the whole file and whose name is its first heading.
func ParseProposal(b []byte) (*Proposal, error) {
	p := &Proposal{Status: "open"}
	s := string(b)
	if fm, body, ok, err := SplitFrontmatter(s); err != nil {
		return nil, err
	} else if ok {
		if err := UnmarshalTOML([]byte(fm), p); err != nil {
			return nil, fmt.Errorf("frontmatter: %w", err)
		}
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

// FrontmatterDelim opens and closes a proposal's TOML frontmatter (Hugo's convention).
const FrontmatterDelim = "+++"

// SplitFrontmatter splits a proposal file into its TOML frontmatter and body.
// ok is false when the file has no frontmatter.
func SplitFrontmatter(s string) (fm, body string, ok bool, err error) {
	if !strings.HasPrefix(s, FrontmatterDelim+"\n") && !strings.HasPrefix(s, FrontmatterDelim+"\r\n") {
		return "", "", false, nil
	}
	rest := s[strings.Index(s, "\n")+1:]
	var end int
	if strings.HasPrefix(rest, FrontmatterDelim) {
		end = 0
	} else if end = strings.Index(rest, "\n"+FrontmatterDelim); end < 0 {
		return "", "", false, fmt.Errorf("frontmatter is not closed with %s", FrontmatterDelim)
	} else {
		end++
	}
	fm = rest[:end]
	body = rest[end+len(FrontmatterDelim):]
	body = strings.TrimPrefix(strings.TrimPrefix(body, "\r"), "\n")
	return fm, body, true, nil
}

var firstHeading = regexp.MustCompile(`(?m)^#+\s+(.+)$`)

// Marshal renders the proposal back to its file form.
func (p *Proposal) Marshal() ([]byte, error) {
	fm, err := MarshalTOML(p)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.WriteString(FrontmatterDelim + "\n")
	buf.Write(fm)
	buf.WriteString(FrontmatterDelim + "\n")
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
