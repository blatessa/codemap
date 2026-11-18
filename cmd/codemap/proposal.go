package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"codemap/internal/cli"
	"codemap/internal/project"
)

func init() {
	commands["proposal"] = func(args []string) error { return runProposal(os.Stdout, os.Stdin, args) }
}

const proposalUsage = `proposal list
       | new <name> [--body FILE|-]
       | archive <slug> [--pr N]
       | show <slug> [--status open|done|wontfix]
       | item <slug> <id> [--status open|done|wontfix] [--reply TEXT]
       | request <slug> --kind KIND --target ID [--file F --lines A-B] [--to X] --text TEXT
       [--root DIR] [--json]`

// today and gitHead are variables so tests can fix them.
var (
	today   = func() string { return time.Now().Format("2006-01-02") }
	gitHead = func(root string) string {
		out, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
)

func runProposal(w io.Writer, in io.Reader, args []string) error {
	var c cli.Common
	fs := cli.NewFlagSet("proposal", proposalUsage)
	c.Register(fs)
	body := fs.String("body", "", "new: read the Markdown body from FILE, or - for stdin")
	pr := fs.String("pr", "", "archive: the pull request that implemented it")
	var f itemFlags
	fs.StringVar(&f.status, "status", "", "show: only items with this status; item: set the status (open, done, wontfix)")
	fs.StringVar(&f.reply, "reply", "", "item: your reply to the request")
	fs.StringVar(&f.kind, "kind", "change", "request: change, add, remove, move, rename, test or question")
	fs.StringVar(&f.target, "target", "", `request: a node or module ID, an edge as "from -> to", or a file path`)
	fs.StringVar(&f.file, "file", "", "request: the file the request is about")
	fs.StringVar(&f.lines, "lines", "", "request: a line or range in --file, as N or A-B")
	fs.StringVar(&f.to, "to", "", "request: for move, the destination module; for rename, the new name")
	fs.StringVar(&f.text, "text", "", "request: what to do")
	pos, err := cli.Parse(fs, args)
	if err != nil {
		return err
	}
	if err := c.CheckRev(); err != nil {
		return err
	}
	if len(pos) == 0 {
		return cli.Usage(proposalUsage)
	}
	switch {
	case pos[0] == "list" && len(pos) == 1:
		return proposalList(w, c)
	case pos[0] == "new" && len(pos) >= 2:
		return proposalNew(w, in, c, strings.Join(pos[1:], " "), *body)
	case pos[0] == "archive" && len(pos) == 2:
		return proposalArchive(w, c, pos[1], *pr)
	case pos[0] == "show" && len(pos) == 2:
		return proposalShow(w, c, pos[1], f.status)
	case pos[0] == "item" && len(pos) == 3:
		replySet := false
		fs.Visit(func(fl *flag.Flag) { replySet = replySet || fl.Name == "reply" })
		return proposalItem(w, c, pos[1], pos[2], f, replySet)
	case pos[0] == "request" && len(pos) == 2:
		return proposalRequest(w, c, pos[1], f)
	}
	return cli.Usage(proposalUsage)
}

func proposalList(w io.Writer, c cli.Common) error {
	p, err := project.Load(c.Root)
	if err != nil {
		return err
	}
	if c.JSON {
		return cli.WriteJSON(w, nonNil(p.Proposals))
	}
	if len(p.Proposals) == 0 {
		fmt.Fprintln(w, "no proposals")
		return nil
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "SLUG\tSTATUS\tPR\tUPDATED\tNAME")
	for _, pr := range p.Proposals {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", pr.Slug, pr.Status, dash(pr.PR), dash(pr.Updated), pr.Name)
	}
	return tw.Flush()
}

func proposalNew(w io.Writer, in io.Reader, c cli.Common, name, bodyFrom string) error {
	slug := project.Slugify(name)
	rel := "proposals/" + slug + ".md"
	full := filepath.Join(c.Root, project.Dir, filepath.FromSlash(rel))
	if _, err := os.Stat(full); err == nil {
		return fmt.Errorf("%s already exists", filepath.Join(project.Dir, rel))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var body []byte
	var err error
	switch bodyFrom {
	case "":
	case "-":
		body, err = io.ReadAll(in)
	default:
		body, err = os.ReadFile(bodyFrom)
	}
	if err != nil {
		return err
	}
	p := &project.Proposal{
		Slug: slug, Name: name, Status: "open",
		Base: gitHead(c.Root), Updated: today(), Body: string(body),
	}
	data, err := p.Marshal()
	if err != nil {
		return err
	}
	if err := project.WriteFile(c.Root, rel, data); err != nil {
		return err
	}
	if c.JSON {
		return cli.WriteJSON(w, p)
	}
	fmt.Fprintf(w, "created %s\n", filepath.Join(project.Dir, rel))
	return nil
}

func proposalArchive(w io.Writer, c cli.Common, slug, pr string) error {
	rel := "proposals/" + slug + ".md"
	b, err := os.ReadFile(filepath.Join(c.Root, project.Dir, filepath.FromSlash(rel)))
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("no proposal %q (see codemap proposal list)", slug)
	}
	if err != nil {
		return err
	}
	p, err := project.ParseProposal(b)
	if err != nil {
		return fmt.Errorf("%s: %w", rel, err)
	}
	p.Slug = slug
	p.Status, p.Updated = "archived", today()
	set := [][2]string{{"status", p.Status}}
	if pr != "" {
		if !strings.HasPrefix(pr, "#") && !strings.Contains(pr, "/") {
			pr = "#" + pr
		}
		p.PR = pr
		set = append(set, [2]string{"pr", pr})
	}
	set = append(set, [2]string{"updated", p.Updated})
	data, err := setFrontmatter(b, set)
	if err != nil {
		// No frontmatter to edit in place (or it's unusual): write the whole file.
		if data, err = p.Marshal(); err != nil {
			return err
		}
	}
	if err := project.WriteFile(c.Root, rel, data); err != nil {
		return err
	}
	if c.JSON {
		return cli.WriteJSON(w, p)
	}
	msg := "archived " + slug
	if p.PR != "" {
		msg += " (" + p.PR + ")"
	}
	fmt.Fprintln(w, msg)
	return nil
}
