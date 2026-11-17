// Package gin is a signature-only stand-in for github.com/gin-gonic/gin.
package gin

type Context struct{}

type HandlerFunc func(*Context)

type IRoutes interface {
	Use(...HandlerFunc) IRoutes
}

type RouterGroup struct{}

func (g *RouterGroup) Use(h ...HandlerFunc) IRoutes                         { return nil }
func (g *RouterGroup) Group(path string, h ...HandlerFunc) *RouterGroup     { return g }
func (g *RouterGroup) GET(path string, h ...HandlerFunc) IRoutes            { return nil }
func (g *RouterGroup) POST(path string, h ...HandlerFunc) IRoutes           { return nil }
func (g *RouterGroup) Any(path string, h ...HandlerFunc) IRoutes            { return nil }
func (g *RouterGroup) Handle(method, path string, h ...HandlerFunc) IRoutes { return nil }

type Engine struct{ RouterGroup }

func New() *Engine     { return &Engine{} }
func Default() *Engine { return &Engine{} }
