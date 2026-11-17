package graph

import (
	"os"
	"testing"
)

// The hand-written expected graph for the fixture is the contract the extractors
// aim for and the viewer develops against. It must stay valid.
func TestExpectedFixtureGraph(t *testing.T) {
	f, err := os.Open("../../testdata/shop.expected.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	g, err := Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range Validate(g) {
		t.Error(e)
	}
	ix := NewIndex(g)

	start := "page:/checkout"
	down := ix.Down(start, ix.StopAtExternal(start))
	for _, want := range []string{
		"ts:web/src/components/PlaceOrderButton.tsx#PlaceOrderButton.onClick",
		"route:POST /orders",
		"go:shop/internal/orders.(*Service).Place",
		"table:orders",
		"ext:stripe",
		"topic:order.placed",
	} {
		if !down.Nodes[want] {
			t.Errorf("checkout should reach %s", want)
		}
	}
	if down.Nodes["go:shop/internal/payments.(*Handler).HandleWebhook"] {
		t.Error("checkout should not trace through Stripe into the webhook")
	}

	if got := ix.EntriesReaching("go:shop/internal/orders.(*Repo).UpdateStatus"); len(got) != 1 || got[0] != "route:POST /webhooks/stripe" {
		t.Errorf("UpdateStatus should only be reached from the webhook, got %v", got)
	}
	// Note: TestPlace_* "reach" (*payments.Client).Charge here even though they use
	// fakes, because one merged call graph can't tell test wiring from production
	// wiring. That over-approximation is accepted for now.
	tests := ix.TestsReaching("ts:web/src/components/PlaceOrderButton.tsx#PlaceOrderButton.onClick")
	if len(tests) != 1 {
		t.Errorf("the vitest test should reach onClick: %v", tests)
	}
	if tests := ix.TestsReaching("route:POST /orders"); len(tests) != 0 {
		t.Errorf("frontend tests must not reach the server: %v", tests)
	}
}
