package app

import (
	"flag"
	"os"
)

// A command registry: a map from names to functions.
var subcommands = map[string]func(args []string) error{
	"build": runBuild,
}

func init() {
	subcommands["show"] = func(args []string) error { Show(); return nil }
}

func runBuild(args []string) error { Build(); return nil }

// handlers maps names to functions too, but isn't named like commands.
var handlers = map[string]func(){"audit": Build}

// SwitchMain dispatches on the first argument.
func SwitchMain() {
	switch os.Args[1] {
	case "deploy", "push":
		Deploy()
	case "-h", "--help":
		Help()
	}
}

// FlagMain dispatches on flag.Args() and flag.Arg.
func FlagMain() {
	flag.Parse()
	args := flag.Args()
	switch args[0] {
	case "lint":
		Lint()
	}
	switch cmd := flag.Arg(0); cmd {
	case "fmt":
		Format()
	}
}

// ModeSwitch switches over a string that isn't an argument: no commands.
func ModeSwitch(mode string) {
	switch mode {
	case "fast":
		Build()
	}
}

func Build()  {}
func Show()   {}
func Deploy() {}
func Help()   {}
func Lint()   {}
func Format() {}
