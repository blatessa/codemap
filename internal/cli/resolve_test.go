package cli

import (
	"flag"
	"reflect"
	"testing"

	"github.com/blatessa/codemap/internal/build"
	"github.com/blatessa/codemap/internal/graph"
)

func shopIndex(t *testing.T) *graph.Index {
	t.Helper()
	g, _, err := build.Load("../../testdata/shop", build.Options{GraphFile: "../../testdata/shop.expected.json"})
	if err != nil {
		t.Fatal(err)
	}
	return graph.NewIndex(g)
}

func TestMatchNodes(t *testing.T) {
	ix := shopIndex(t)
	cases := []struct {
		arg  string
		want []string
	}{
		{"go:shop/internal/orders.(*Service).Place", []string{"go:shop/internal/orders.(*Service).Place"}}, // 1. ID
		{"POST /orders", []string{"route:POST /orders"}},                                                   // 2. route
		{"get /orders/{id}", []string{"route:GET /orders/:id"}},                                            // 2. braces, lower-case method
		{"GET /orders/42", []string{"route:GET /orders/:id"}},                                              // 2. param match
		{"/orders/{orderId}", []string{"page:/orders/:id"}},                                                // 3. page
		{"Repo.UpdateStatus", []string{"go:shop/internal/orders.(*Repo).UpdateStatus"}},                    // 4. label
		{"orders.Service.Place", []string{"go:shop/internal/orders.(*Service).Place"}},                     // 4. printed name
		{"orders [table]", []string{"table:orders"}},                                                       // 4. printed name
		{"updatestatus", []string{"go:shop/internal/orders.(*Repo).UpdateStatus"}},                         // 5. suffix
		{"NewHandler", []string{"go:shop/internal/auth.NewHandler", "go:shop/internal/orders.NewHandler", "go:shop/internal/payments.NewHandler"}},
		{"nope-nothing", nil},
	}
	for _, tc := range cases {
		if got := MatchNodes(ix, tc.arg); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("MatchNodes(%q) = %v, want %v", tc.arg, got, tc.want)
		}
	}
}

func TestMatchModules(t *testing.T) {
	ix := shopIndex(t)
	for arg, want := range map[string]string{
		"mod:go:shop/internal/orders": "mod:go:shop/internal/orders",
		"internal/orders/":            "mod:go:shop/internal/orders",
		"database":                    "mod:sql:database",
		"Components":                  "mod:ts:web/src/components",
	} {
		if got := MatchModules(ix, arg); len(got) != 1 || got[0] != want {
			t.Errorf("MatchModules(%q) = %v, want %s", arg, got, want)
		}
	}
}

func TestParseInterspersed(t *testing.T) {
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	n := fs.Int("depth", 0, "")
	j := fs.Bool("json", false, "")
	pos, err := Parse(fs, []string{"a", "--depth", "3", "b", "--json", "--", "--c"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pos, []string{"a", "b", "--c"}) || *n != 3 || !*j {
		t.Errorf("pos=%v depth=%d json=%v", pos, *n, *j)
	}
}
