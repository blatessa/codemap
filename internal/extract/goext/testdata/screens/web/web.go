package web

import (
	"html/template"
	"io"
	"net/http"
)

// TplName names a template, the way Gitea does.
type TplName string

const tplOrderList TplName = "shop/orders/list"

// greeting is a template name only in render calls: templates/home.tmpl is
// "home" to the render helper but not to setting.
const greeting = "home"

// tplReceipt is a variable never assigned again: a constant in all but name.
var tplReceipt TplName = "shop/orders/receipt"

// tplUnused is assigned again, so its value isn't known.
var tplUnused = "unused"

func init() { tplUnused = "unused.tmpl" }

func setting(key string) string { return key }

// Page describes a page another function renders.
type Page struct {
	Title    string
	Template TplName
}

func show(c *Ctx, p Page) { c.HTML(http.StatusOK, p.Template) }

var tpl *template.Template

type Ctx struct{ w http.ResponseWriter }

func (c *Ctx) HTML(status int, name TplName) { _ = tpl.ExecuteTemplate(c.w, string(name), nil) }

// render is a helper: the screen is the one its callers name.
func render(w io.Writer, name string) { _ = tpl.ExecuteTemplate(w, name, nil) }

// ListOrders renders through a typed string const.
func ListOrders(c *Ctx) { c.HTML(http.StatusOK, tplOrderList) }

// ShowOrder renders a literal name with its extension.
func ShowOrder(w http.ResponseWriter, r *http.Request) {
	_ = tpl.ExecuteTemplate(w, "shop/orders/view.tmpl", nil)
}

// Dashboard renders through a local variable assigned once.
func Dashboard(w http.ResponseWriter, r *http.Request) {
	name := "admin/dashboard"
	render(w, name)
}

// Login renders through the helper, by a {{define}} name.
func Login(w http.ResponseWriter, r *http.Request) { render(w, "login_form") }

// Home renders a bare-word name through the helper.
func Home(w http.ResponseWriter, r *http.Request) { render(w, greeting) }

// Receipt renders through a package-level variable.
func Receipt(c *Ctx) { c.HTML(http.StatusOK, tplReceipt) }

// Settings names its screen in a struct field.
func Settings(c *Ctx) { show(c, Page{Title: "Settings", Template: "admin/settings"}) }

// Index renders a template outside a templates directory by its file name.
func Index(w http.ResponseWriter, r *http.Request) { _ = tpl.ExecuteTemplate(w, "index.html", nil) }

// Greet passes constant strings that aren't template names, or aren't
// passed to anything that renders.
func Greet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	_, _ = io.WriteString(w, setting(greeting))
	render(w, "content") // defined by two templates: ambiguous
	render(w, tplUnused)
	setting("index.html")         // not a call that renders
	render(w, "static/home.html") // static/home.html has no actions: not a template
}
