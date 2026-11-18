package app

import "github.com/urfave/cli/v2"

func RunUrfave(args []string) error {
	app := &cli.App{
		Name: "tool",
		Commands: []*cli.Command{
			{
				Name:   "sync",
				Usage:  "Sync everything",
				Action: func(c *cli.Context) error { Sync(); return nil },
			},
			{
				Name: "user",
				Subcommands: []*cli.Command{
					{Name: "add", Action: addUser},
				},
			},
		},
	}
	return app.Run(args)
}

func addUser(c *cli.Context) error { AddUser(); return nil }

func Sync()    {}
func AddUser() {}
