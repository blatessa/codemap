// Package echo is a signature-only stand-in for github.com/labstack/echo/v4.
package echo

type Context interface{}

type HandlerFunc func(Context) error

type MiddlewareFunc func(HandlerFunc) HandlerFunc

type Route struct{}

type Echo struct{}

func New() *Echo { return &Echo{} }

func (e *Echo) Use(m ...MiddlewareFunc)                                     {}
func (e *Echo) GET(path string, h HandlerFunc, m ...MiddlewareFunc) *Route  { return nil }
func (e *Echo) POST(path string, h HandlerFunc, m ...MiddlewareFunc) *Route { return nil }
func (e *Echo) Group(prefix string, m ...MiddlewareFunc) *Group             { return nil }
func (e *Echo) Match(methods []string, path string, h HandlerFunc, m ...MiddlewareFunc) []*Route {
	return nil
}

type Group struct{}

func (g *Group) Use(m ...MiddlewareFunc)                                       {}
func (g *Group) GET(path string, h HandlerFunc, m ...MiddlewareFunc) *Route    { return nil }
func (g *Group) DELETE(path string, h HandlerFunc, m ...MiddlewareFunc) *Route { return nil }
func (g *Group) Group(prefix string, m ...MiddlewareFunc) *Group               { return nil }
