package graph

import (
	"regexp"
	"strings"
)

// ID helpers: each function below is the format for one kind of thing. IDs must
// survive unrelated edits, because blocks and proposals refer to them.

// GoFuncID returns the ID of a Go function or method. name uses go/ssa naming,
// e.g. "Place" for a function or "(*Service).Place" for a method.
func GoFuncID(importPath, name string) string { return "go:" + importPath + "." + name }

// TSFuncID returns the ID of a TypeScript function. name may be nested with dots,
// e.g. "PlaceOrderButton.onClick".
func TSFuncID(relPath, name string) string { return "ts:" + relPath + "#" + name }

// ModuleID returns the ID of a module for a language and import path or directory.
func ModuleID(lang, path string) string { return "mod:" + lang + ":" + path }

// RouteID returns the ID of an HTTP route, normalising the path (see NormalizeRoutePath).
func RouteID(method, path string) string {
	return "route:" + strings.ToUpper(method) + " " + NormalizeRoutePath(path)
}

// PageID returns the ID of a frontend page.
func PageID(path string) string { return "page:" + NormalizeRoutePath(path) }

// JobID returns the ID of a scheduled job.
func JobID(name string) string { return "job:" + name }

// CommandID returns the ID of a CLI command. name is its full path below the
// program, e.g. "db migrate".
func CommandID(name string) string { return "cmd:" + name }

// SubscriberID returns the ID of a topic subscriber.
func SubscriberID(topic, handlerID string) string { return "sub:" + topic + ":" + handlerID }

// TableID returns the ID of a database table. Pass schema "" or "public" for the default schema.
func TableID(schema, name string) string {
	if schema == "" || schema == "public" {
		return "table:" + name
	}
	return "table:" + schema + "." + name
}

// TopicID returns the ID of a queue topic.
func TopicID(name string) string { return "topic:" + name }

// ExternalID returns the ID of an external service.
func ExternalID(name string) string { return "ext:" + name }

// ScreenID returns the ID of a server-rendered screen (a template), by its
// name below the templates directory, e.g. "repo/issue/list".
func ScreenID(name string) string { return "screen:" + name }

// TestID returns the ID of a test.
func TestID(lang, id string) string { return "test:" + lang + ":" + id }

var (
	braceParam    = regexp.MustCompile(`\{([^}/]+)\}`)      // {id} or {id:[0-9]+}
	templateParam = regexp.MustCompile(`\$\{[^}]*\}`)       // ${order.id}
	colonParam    = regexp.MustCompile(`:([A-Za-z_][\w]*)`) // :id
	multiSlash    = regexp.MustCompile(`/{2,}`)
)

// NormalizeRoutePath converts router and URL path syntaxes to one ":param" form so
// server routes and frontend fetches can be matched:
//
//	/orders/{id}            -> /orders/:id
//	/orders/{id:[0-9]+}     -> /orders/:id
//	/orders/${order.id}     -> /orders/:param
//	orders/:id/             -> /orders/:id
//	/static/{path...}       -> /static/:path
//
// Query strings and fragments are dropped. Template parameters, whose names are
// expressions rather than names, all become ":param"; use RouteMatch to compare
// paths regardless of parameter names.
func NormalizeRoutePath(p string) string {
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	p = templateParam.ReplaceAllString(p, ":param")
	p = braceParam.ReplaceAllStringFunc(p, func(m string) string {
		name := m[1 : len(m)-1]
		if i := strings.IndexByte(name, ':'); i >= 0 {
			name = name[:i]
		}
		name = strings.TrimSuffix(name, "...")
		return ":" + name
	})
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	p = multiSlash.ReplaceAllString(p, "/")
	if len(p) > 1 {
		p = strings.TrimSuffix(p, "/")
	}
	return p
}

// RouteMatch reports whether two normalised paths match, treating every
// ":param" segment as a wildcard.
func RouteMatch(a, b string) bool {
	as, bs := strings.Split(a, "/"), strings.Split(b, "/")
	if len(as) != len(bs) {
		return false
	}
	for i := range as {
		if isParam(as[i]) || isParam(bs[i]) {
			continue
		}
		if as[i] != bs[i] {
			return false
		}
	}
	return true
}

func isParam(seg string) bool { return colonParam.MatchString(seg) && strings.HasPrefix(seg, ":") }
