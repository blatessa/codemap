// Package rules holds tables built when the package is initialised.
package rules

import "strings"

// names is built by a call only the package's variable initialisers make.
var names = build("a", "b")

func build(list ...string) map[string]bool {
	m := map[string]bool{}
	for _, s := range list {
		m[strings.ToLower(s)] = true
	}
	return m
}

// handlers stores function literals: they run when Run calls them.
var handlers = map[string]func() error{
	"a": func() error { return doA() },
}

func doA() error { return nil }

func Run(name string) error {
	if !names[name] {
		return nil
	}
	return handlers[name]()
}
