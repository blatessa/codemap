package goext

import (
	"sort"
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

func TestScreens(t *testing.T) {
	g, err := Extract("testdata/screens", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	files := map[string]string{}
	for _, n := range g.Nodes {
		if n.Kind == graph.KindScreen {
			files[n.ID] = n.File
			if n.Module != ScreensModule || !n.External || n.Line != 1 || n.Label != strings.TrimPrefix(n.ID, "screen:") {
				t.Errorf("%s: module %s, external %v, line %d, label %s", n.ID, n.Module, n.External, n.Line, n.Label)
			}
		}
	}
	wantFiles := map[string]string{
		"screen:shop/orders/list":    "templates/shop/orders/list.tmpl",
		"screen:shop/orders/view":    "templates/shop/orders/view.tmpl",
		"screen:admin/dashboard":     "templates/admin/dashboard.gohtml",
		"screen:auth":                "templates/auth.html",
		"screen:home":                "templates/home.tmpl",
		"screen:shop/orders/receipt": "templates/shop/orders/receipt.tmpl",
		"screen:admin/settings":      "templates/admin/settings.tmpl",
		"screen:partials/header":     "templates/partials/header.tmpl",
		"screen:partials/nav":        "templates/partials/nav.tmpl",
		"screen:partials/row":        "templates/partials/row.tmpl",
		"screen:static/index":        "static/index.html",
		// not templates/unused.tmpl (never rendered), nor static/home.html
		// (no {{actions}} outside a templates directory: a static file)
	}
	if len(files) != len(wantFiles) {
		t.Errorf("screens %v, want %v", files, wantFiles)
	}
	for id, f := range wantFiles {
		if files[id] != f {
			t.Errorf("%s: file %q, want %q", id, files[id], f)
		}
	}
	// templates/ and static/: their common directory is the root
	for _, m := range g.Modules {
		if m.ID == ScreensModule && (m.Path != "" || !m.External) {
			t.Errorf("screens module %+v", m)
		}
	}

	var got []string
	for _, e := range g.Edges {
		if e.Type == graph.Renders {
			got = append(got, strings.TrimPrefix(e.From, "go:screens/web.")+" -> "+e.To)
		}
	}
	sort.Strings(got)
	want := []string{
		"Dashboard -> screen:admin/dashboard",   // a local variable, through the render helper
		"Home -> screen:home",                   // a bare word, to a function named render
		"Index -> screen:static/index",          // a file name, outside a templates directory
		"ListOrders -> screen:shop/orders/list", // a typed string const
		"Login -> screen:auth",                  // a {{define}} name
		"Receipt -> screen:shop/orders/receipt", // a package-level variable never assigned again
		"Settings -> screen:admin/settings",     // a struct field
		"ShowOrder -> screen:shop/orders/view",  // a literal with the extension
		// partials included with {{template}}
		"screen:partials/header -> screen:partials/nav",
		"screen:shop/orders/list -> screen:partials/header",
		"screen:shop/orders/list -> screen:partials/row",
		"screen:shop/orders/view -> screen:partials/header",
		// not Greet: setting isn't about rendering, "content" is defined by
		// two templates, tplUnused is assigned twice, and static/home.html
		// isn't a template
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("renders edges:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}

	// a feature lists the screens it shows; their partials are the screen's business
	ix := graph.NewIndex(g)
	effects := ix.EffectsBeneath("go:screens/web.ListOrders")
	if len(effects) != 1 || effects[0] != (graph.Effect{To: "screen:shop/orders/list", Type: graph.Renders}) {
		t.Errorf("ListOrders effects %v", effects)
	}
}
