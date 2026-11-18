package build

import (
	"testing"

	"github.com/blatessa/codemap/internal/graph"
)

func TestLoadFromGraphFile(t *testing.T) {
	g, p, err := Load("../../testdata/shop", Options{GraphFile: "../../testdata/shop.expected.json"})
	if err != nil {
		t.Fatal(err)
	}
	if errs := graph.Validate(g); len(errs) > 0 {
		t.Fatal(errs)
	}
	if len(p.External.Nodes) == 0 {
		t.Error("project not loaded")
	}
	ix := graph.NewIndex(g)
	if ix.Node["ext:stripe"].Fields["owner"] != "Payments team" {
		t.Error("declared fields missing")
	}
}

// Roles on the fixture (internal/graph/roles.go). Every function not listed is core.
func TestFixtureRoles(t *testing.T) {
	g, _, err := Load("../../testdata/shop", Options{GraphFile: "../../testdata/shop.expected.json"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"go:shop/cmd/server.main":                          graph.RoleWiring,
		"go:shop/cmd/server.routes":                        graph.RoleWiring,
		"go:shop/cmd/server.jobs":                          graph.RoleWiring,
		"go:shop/cmd/server.subscribers":                   graph.RoleWiring,
		"go:shop/internal/events.(*Bus).Subscribe":         graph.RoleWiring,
		"go:shop/internal/auth.NewHandler":                 graph.RoleWiring,
		"go:shop/internal/auth.NewStore":                   graph.RoleWiring,
		"go:shop/internal/events.NewBus":                   graph.RoleWiring,
		"go:shop/internal/inventory.NewStore":              graph.RoleWiring,
		"go:shop/internal/notify.NewMailer":                graph.RoleWiring,
		"go:shop/internal/orders.NewHandler":               graph.RoleWiring,
		"go:shop/internal/orders.NewRepo":                  graph.RoleWiring,
		"go:shop/internal/orders.NewService":               graph.RoleWiring,
		"go:shop/internal/payments.NewClient":              graph.RoleWiring,
		"go:shop/internal/payments.NewHandler":             graph.RoleWiring,
		"go:shop/internal/sched.New":                       graph.RoleWiring,
		"go:shop/internal/orders.writeJSON":                graph.RoleUtility,
		"go:shop/internal/orders.writeError":               graph.RoleUtility,
		"go:shop/internal/auth.CurrentUser":                graph.RoleUtility,
		"go:shop/internal/auth.withUser":                   graph.RoleUtility,
		"go:shop/internal/auth.(*Handler).sign":            graph.RoleUtility,
		"go:shop/internal/auth.(*Handler).issueToken":      graph.RoleUtility,
		"go:shop/internal/auth.(*Handler).parseToken":      graph.RoleUtility,
		"go:shop/cmd/server.(logConn).Publish":             graph.RoleUtility,
		"ts:web/src/api/http.ts#http.get":                  graph.RoleUtility,
		"ts:web/src/api/http.ts#http.post":                 graph.RoleUtility,
		"ts:web/src/api/http.ts#request":                   graph.RoleUtility,
		"ts:web/src/state/cart.ts#useCart":                 graph.RoleUtility,
		"go:shop/internal/events.(*Bus).Publish":           graph.RolePassthrough,
		"ts:web/src/components/OrderStatus.tsx#useOrder":   graph.RolePassthrough,
		"go:shop/internal/inventory.(ErrOutOfStock).Error": graph.RoleUnreachable,
	}
	for _, n := range g.Nodes {
		got, _ := n.Fields["role"].(string)
		if got != want[n.ID] {
			t.Errorf("%s: role %q, want %q", n.ID, got, want[n.ID])
		}
		if n.Fields["entry_reason"] != nil {
			t.Errorf("%s: the fixture has entry points, so nothing is exported-as-entry", n.ID)
		}
	}
}

func TestLoadWithoutExtractors(t *testing.T) {
	if _, _, err := Load("../../testdata/shop", Options{}); err != ErrNoExtractors {
		t.Fatalf("got %v", err)
	}
}
