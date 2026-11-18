// Package cli is a signature-only stand-in for github.com/urfave/cli/v2.
package cli

type Context struct{}

type ActionFunc func(*Context) error

type Command struct {
	Name        string
	Usage       string
	Action      ActionFunc
	Subcommands []*Command
}

type App struct {
	Name     string
	Commands []*Command
}

func (a *App) Run(args []string) error { return nil }
