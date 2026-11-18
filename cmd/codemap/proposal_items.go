package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"codemap/internal/anchor"
	"codemap/internal/cli"
	"codemap/internal/gitrev"
	"codemap/internal/project"
)

// openRepo opens the git repo at root, or returns nil (tests may replace it).
var openRepo = func(root string) *gitrev.Repo {
	r, err := gitrev.Open(root)
	if err != nil {
		return nil
	}
	return r
}

type itemFlags struct {
	status, reply          string
	kind, target, file, to string
	lines, text            string
}

func readProposalFile(root, slug string) (*project.Proposal, []byte, error) {
	rel := "proposals/" + slug + ".md"
	b, err := os.ReadFile(filepath.Join(root, project.Dir, filepath.FromSlash(rel)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, fmt.Errorf("no proposal %q (see codemap proposal list)", slug)
	}
	if err != nil {
		return nil, nil, err
	}
	p, err := project.ParseProposal(b)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", rel, err)
	}
	p.Slug = slug
	return p, b, nil
}

// writeItems writes an item edit: in place when that worked, else the whole file.
func writeItems(root string, p *project.Proposal, inPlace []byte, err error) error {
	p.Updated = today()
	var data []byte
	if err == nil {
		data, err = project.SetFrontmatter(inPlace, [][2]string{{"updated", p.Updated}})
	}
	if err != nil {
		if data, err = p.Marshal(); err != nil {
			return err
		}
	}
	return project.WriteFile(root, "proposals/"+p.Slug+".md", data)
}

// shortLabel turns a node, module or edge id into something readable:
// go:shop/internal/orders.(*Service).Place is orders.Service.Place.
func shortLabel(id string) string {
	if from, to, ok := strings.Cut(id, " -> "); ok {
		return shortLabel(from) + " -> " + shortLabel(to)
	}
	s := id
	for _, p := range []string{"mod:go:", "mod:ts:", "mod:", "go:", "ts:", "test:go:", "test:ts:"} {
		if strings.HasPrefix(id, p) {
			s = id[len(p):]
			if i := strings.LastIndex(s, "/"); i >= 0 {
				s = s[i+1:]
			}
			break
		}
	}
	if strings.HasPrefix(id, "test:") {
		if i := strings.LastIndex(s, "."); i >= 0 {
			s = s[i+1:]
		}
	}
	s = strings.NewReplacer("(*", "", ")", "", "#", ".").Replace(s)
	return strings.TrimPrefix(s, "new:")
}

func itemsSummary(p *project.Proposal) (open, total int) {
	for _, it := range p.Items {
		total++
		if st := project.ItemStr(it, "status"); st == "" || st == "open" {
			open++
		}
	}
	return
}

func proposalShow(w io.Writer, c cli.Common, slug, status string) error {
	if status != "" && !slices.Contains(project.ItemStatuses, status) {
		return &cli.ExitError{Code: 2, Err: errors.New("--status must be open, done or wontfix")}
	}
	p, _, err := readProposalFile(c.Root, slug)
	if err != nil {
		return err
	}
	repo := openRepo(c.Root)
	if repo != nil {
		defer repo.Close()
	}
	res := &anchor.Resolver{Root: c.Root, Repo: repo}
	type shown struct {
		it map[string]any
		a  *anchor.Anchor
	}
	var list []shown
	for _, it := range p.Items {
		st := project.ItemStr(it, "status")
		if st == "" {
			st = "open"
		}
		if status != "" && st != status {
			continue
		}
		list = append(list, shown{it, res.Resolve(it)})
	}
	if c.JSON {
		items := make([]map[string]any, 0, len(list))
		for _, s := range list {
			m := map[string]any{}
			for k, v := range s.it {
				m[k] = v
			}
			if s.a != nil {
				m["anchor"] = s.a
			}
			items = append(items, m)
		}
		out := *p
		out.Items = items
		return cli.WriteJSON(w, out)
	}
	open, total := itemsSummary(p)
	fmt.Fprintf(w, "%s  (%s)\n", p.Name, p.Status)
	fmt.Fprintf(w, "sketch: %d modules, %d nodes, %d edges\n", len(p.Modules), len(p.Nodes), len(p.Edges))
	fmt.Fprintf(w, "items: %d open of %d\n", open, total)
	if len(list) == 0 {
		if total > 0 {
			fmt.Fprintln(w, "\nno items match")
		}
		return nil
	}
	idW, kindW := 0, 0
	for _, s := range list {
		idW = max(idW, len(project.ItemStr(s.it, "id")))
		kindW = max(kindW, len(project.ItemStr(s.it, "kind")))
	}
	ind := strings.Repeat(" ", idW+2)
	for _, s := range list {
		it := s.it
		fmt.Fprintln(w)
		line := fmt.Sprintf("%-*s  %-*s  %s", idW, project.ItemStr(it, "id"), kindW, project.ItemStr(it, "kind"), shortLabel(project.ItemStr(it, "target")))
		if to := project.ItemStr(it, "to"); to != "" {
			if project.ItemStr(it, "kind") == "rename" {
				line += " -> " + strconv.Quote(to)
			} else {
				line += " -> " + shortLabel(to)
			}
		}
		if s.a != nil {
			loc := s.a.File
			if s.a.Lines[0] > 0 {
				loc += ":" + strconv.Itoa(s.a.Lines[0])
				if s.a.Lines[1] > s.a.Lines[0] {
					loc += "-" + strconv.Itoa(s.a.Lines[1])
				}
			}
			if s.a.Stale {
				loc += " (stale)"
			}
			line += "  " + loc
		}
		if st := project.ItemStr(it, "status"); st != "" && st != "open" {
			line += "  [" + st + "]"
		}
		fmt.Fprintln(w, strings.TrimRight(line, " "))
		for _, l := range strings.Split(strings.TrimSpace(project.ItemStr(it, "text")), "\n") {
			if l != "" {
				fmt.Fprintln(w, ind+l)
			}
		}
		if q := strings.TrimSpace(project.ItemStr(it, "quote")); q != "" {
			for _, l := range strings.Split(q, "\n") {
				fmt.Fprintln(w, ind+"> "+l)
			}
		}
		if r := strings.TrimSpace(project.ItemStr(it, "reply")); r != "" {
			for i, l := range strings.Split(r, "\n") {
				pre := "reply: "
				if i > 0 {
					pre = "       "
				}
				fmt.Fprintln(w, ind+pre+l)
			}
		}
	}
	return nil
}

func proposalItem(w io.Writer, c cli.Common, slug, id string, f itemFlags, replySet bool) error {
	set := map[string]any{}
	if f.status != "" {
		if !slices.Contains(project.ItemStatuses, f.status) {
			return &cli.ExitError{Code: 2, Err: errors.New("--status must be open, done or wontfix")}
		}
		set["status"] = f.status
	}
	if replySet {
		set["reply"] = f.reply
	}
	if len(set) == 0 {
		return &cli.ExitError{Code: 2, Err: errors.New("give --status and/or --reply")}
	}
	p, b, err := readProposalFile(c.Root, slug)
	if err != nil {
		return err
	}
	i := p.FindItem(id)
	if i < 0 {
		return fmt.Errorf("no item %q in %s (see codemap proposal show %s)", id, slug, slug)
	}
	for k, v := range set {
		p.Items[i][k] = v
	}
	data, perr := project.PatchItem(b, id, set)
	if err := writeItems(c.Root, p, data, perr); err != nil {
		return err
	}
	if c.JSON {
		return cli.WriteJSON(w, p.Items[i])
	}
	st := project.ItemStr(p.Items[i], "status")
	fmt.Fprintf(w, "%s %s: %s\n", slug, id, st)
	return nil
}

func parseLines(s string) (int, int, error) {
	a, b, _ := strings.Cut(s, "-")
	x, err := strconv.Atoi(strings.TrimSpace(a))
	if err != nil || x < 1 {
		return 0, 0, fmt.Errorf("--lines %q: want N or A-B", s)
	}
	y := x
	if b != "" {
		if y, err = strconv.Atoi(strings.TrimSpace(b)); err != nil || y < x {
			return 0, 0, fmt.Errorf("--lines %q: want N or A-B", s)
		}
	}
	return x, y, nil
}

func proposalRequest(w io.Writer, c cli.Common, slug string, f itemFlags) error {
	if f.kind == "" {
		f.kind = "change"
	}
	if !slices.Contains(project.ItemKinds, f.kind) {
		return &cli.ExitError{Code: 2, Err: errors.New("--kind must be one of " + strings.Join(project.ItemKinds, ", "))}
	}
	if f.target == "" && f.file == "" {
		return &cli.ExitError{Code: 2, Err: errors.New("give --target (a node, module, \"from -> to\" edge or file) or --file")}
	}
	if strings.TrimSpace(f.text) == "" {
		return &cli.ExitError{Code: 2, Err: errors.New("give --text")}
	}
	p, b, err := readProposalFile(c.Root, slug)
	if err != nil {
		return err
	}
	it := map[string]any{"id": p.NextItemID(), "kind": f.kind}
	if f.target != "" {
		it["target"] = f.target
	} else {
		it["target"] = f.file
	}
	if f.file != "" {
		it["file"] = filepath.ToSlash(f.file)
		if f.lines != "" {
			a, z, err := parseLines(f.lines)
			if err != nil {
				return &cli.ExitError{Code: 2, Err: err}
			}
			it["lines"] = []int64{int64(a), int64(z)}
			if q := anchor.QuoteFile(c.Root, f.file, a, z); q != "" {
				it["quote"] = q
			}
		}
	} else if f.lines != "" {
		return &cli.ExitError{Code: 2, Err: errors.New("--lines needs --file")}
	}
	if h := gitHead(c.Root); h != "" {
		it["rev"] = shortSHA(h)
	}
	if f.to != "" {
		it["to"] = f.to
	}
	it["text"] = f.text
	it["status"] = "open"
	data, perr := project.AppendItem(b, it)
	p.Items = append(p.Items, it)
	if err := writeItems(c.Root, p, data, perr); err != nil {
		return err
	}
	if c.JSON {
		return cli.WriteJSON(w, it)
	}
	fmt.Fprintf(w, "added %s to %s\n", it["id"], slug)
	return nil
}

func shortSHA(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}
