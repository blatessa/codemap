package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"codemap/internal/build"
)

func init() { commands["build"] = runBuild }

// runBuild implements `codemap build [--root .] [--graph FILE] [--out graph.json]`.
func runBuild(args []string) error {
	fset := flag.NewFlagSet("build", flag.ContinueOnError)
	root := fset.String("root", ".", "repo root")
	graphFile := fset.String("graph", "", "read this graph.json instead of running the extractors")
	out := fset.String("out", "", "write the graph here instead of stdout")
	if err := fset.Parse(args); err != nil {
		return err
	}
	if fset.NArg() > 0 {
		return fmt.Errorf("build: unexpected argument %q", fset.Arg(0))
	}
	g, _, err := build.Load(*root, build.Options{GraphFile: *graphFile})
	if errors.Is(err, build.ErrNoExtractors) {
		return errors.New("build: no extractors are wired in yet; pass --graph FILE (for example testdata/shop.expected.json)")
	}
	if err != nil {
		return fmt.Errorf("build: %w", err)
	}
	if *out == "" || *out == "-" {
		return g.Encode(os.Stdout)
	}
	f, err := os.Create(*out)
	if err != nil {
		return err
	}
	if err := g.Encode(f); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
