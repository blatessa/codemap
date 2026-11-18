package app

import "context"

// A home-made command table, the way many small CLIs dispatch.
type command struct {
	name  string
	usage string
	run   func(ctx context.Context, args []string) error
}

var commands []*command

func register(c *command) { commands = append(commands, c) }

func init() {
	register(&command{
		name: "join", usage: "join <url>",
		run: func(ctx context.Context, args []string) error { Join(); return nil },
	})
	register(&command{name: "server start", usage: "server start [--addr <host:port>]", run: startServer})
	for _, st := range []struct{ name, action string }{
		{"ready", "ready"},
		{"close", "close"},
	} {
		register(&command{
			name: st.name, usage: st.name + " [<task>]",
			run: func(ctx context.Context, args []string) error { SetStatus(st.action); return nil },
		})
	}
}

func startServer(ctx context.Context, args []string) error { StartServer(); return nil }

// Dispatch runs the named command.
func Dispatch(name string, args []string) error {
	for _, c := range commands {
		if c.name == name {
			return c.run(context.Background(), args)
		}
	}
	return nil
}

// Plugin has a name and a function but isn't a command.
type Plugin struct {
	Name string
	Init func()
}

var plugins = []Plugin{{Name: "audit", Init: func() { Join() }}}

func Join()            {}
func StartServer()     {}
func SetStatus(string) {}
