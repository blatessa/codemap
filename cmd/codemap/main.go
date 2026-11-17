// Command codemap builds and serves an architecture map of a codebase.
// See PLAN.md. Subcommands are added by the workstreams in §12.
package main

import (
	"fmt"
	"os"

	"codemap/internal/cli"
)

const usage = `usage: codemap <command> [flags]

commands:
  build     extract the graph for a revision and print or write it
  serve     run the viewer on localhost
  show      print the call tree below an entry point or function
  callers   print what calls a node
  module    print a module's contents and connections
  search    search labels, files and doc comments
  proposal  list, create or archive proposals
`

// commands is filled in by the files that implement each subcommand.
var commands = map[string]func(args []string) error{}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	run, ok := commands[os.Args[1]]
	if !ok {
		fmt.Fprintf(os.Stderr, "codemap: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err := run(os.Args[2:]); err != nil {
		os.Exit(cli.Report(os.Stderr, err)) // prints err; exit status from cli.ExitError, else 1
	}
}
