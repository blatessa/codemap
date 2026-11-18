// Command codemap builds and serves an architecture map of a codebase.
package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"github.com/blatessa/codemap/internal/cli"
)

const usage = `usage: codemap <command> [flags]

commands:
  build     extract the graph for a revision and print or write it
  serve     run the viewer on localhost
  show      print the call tree below an entry point or function
  callers   print what calls a node
  module    print a module's contents and connections
  modules   list every module with its size, area and dependencies
  search    search labels, files and doc comments
  diff      summarise what changed between two revisions (default HEAD..worktree)
  proposal  list, create or archive proposals
  version   print the version
`

// commands is filled in by the files that implement each subcommand.
var commands = map[string]func(args []string) error{}

// version is set by release builds (-ldflags "-X main.version=v1.2.3"). A
// `go install …@v1.2.3` build reads it from the module instead.
var version = ""

func init() {
	commands["version"] = func([]string) error {
		v := version
		if v == "" {
			v = "dev"
			if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
				v = bi.Main.Version
			}
		}
		fmt.Println("codemap", v)
		return nil
	}
}

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		os.Args[1] = "version"
	}
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
