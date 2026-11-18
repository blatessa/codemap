package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codemap/internal/project"
)

type itemResp struct {
	Version string
	Item    map[string]any
}

func refundsOf(ps []*project.Proposal) *project.Proposal {
	for _, p := range ps {
		if p.Slug == "refunds" {
			return p
		}
	}
	return nil
}

func TestProposalItems(t *testing.T) {
	_, ts, root := setup(t)
	file := filepath.Join(root, ".codemap/proposals/refunds.md")

	// anchors come with the proposals
	refunds := refundsOf(getState(t, ts).Project.Proposals)
	if refunds == nil || len(refunds.Items) != 3 {
		t.Fatalf("refunds items: %+v", refunds)
	}
	a, _ := refunds.Items[0]["anchor"].(map[string]any)
	if a == nil || a["file"] != "internal/orders/service.go" || a["stale"] != nil {
		t.Errorf("anchor: %v", refunds.Items[0]["anchor"])
	}
	if _, has := refunds.Items[1]["anchor"]; has {
		t.Error("an item without a file has no anchor")
	}

	before, _ := os.ReadFile(file)
	head := string(before[:strings.Index(string(before), "updated")])
	// append
	r := do(t, ts, "POST", "/api/proposals/refunds/items", map[string]any{
		"kind": "change", "target": "go:shop/internal/orders.(*Service).MarkPaid", "file": "internal/orders/service.go",
		"lines": []int{66, 66}, "quote": `o, err := s.repo.UpdateStatus(ctx, chargeID, "paid")`, "text": "Check the charge exists",
		"id": "mine", "status": "done", "anchor": map[string]any{"file": "x"},
	})
	if r.status != 200 {
		t.Fatalf("post: %d %s", r.status, r.body)
	}
	var ir itemResp
	r.decode(t, &ir)
	if ir.Item["id"] != "i4" || ir.Item["status"] != "open" || ir.Item["rev"] != "3f2c9e1" || ir.Item["anchor"] == nil {
		t.Errorf("posted item: %v", ir.Item)
	}
	b, _ := os.ReadFile(file)
	if !strings.HasPrefix(string(b), head) || strings.Contains(string(b), "anchor") {
		t.Errorf("not appended in place:\n%s", b)
	}
	// the multi-line quote of i1 is kept as written
	if !strings.Contains(string(b), "quote = \"\"\"\ncharge, err") || !strings.Contains(string(b), "[[item]]\nid = 'i4'") {
		t.Errorf("file:\n%s", b)
	}
	if ir.Version != version(b) {
		t.Error("version")
	}

	// patch
	r = do(t, ts, "PATCH", "/api/proposals/refunds/items/i2", map[string]any{"status": "done", "reply": "Added TestPlace_ChargeFails"}, "If-Match", ir.Version)
	if r.status != 200 {
		t.Fatalf("patch: %d %s", r.status, r.body)
	}
	var pr itemResp
	r.decode(t, &pr)
	if pr.Item["status"] != "done" || pr.Item["reply"] != "Added TestPlace_ChargeFails" {
		t.Errorf("patched: %v", pr.Item)
	}
	b, _ = os.ReadFile(file)
	if !strings.Contains(string(b), "status = 'done'\nreply = 'Added TestPlace_ChargeFails'\n\n[[item]]\nid = 'i3'") {
		t.Errorf("patched file:\n%s", b)
	}
	// stale If-Match, bad values, missing items
	if r := do(t, ts, "PATCH", "/api/proposals/refunds/items/i2", map[string]any{"status": "open"}, "If-Match", ir.Version); r.status != 409 {
		t.Errorf("stale patch: %d", r.status)
	}
	if r := do(t, ts, "PATCH", "/api/proposals/refunds/items/i2", map[string]any{"status": "finished"}); r.status != 400 {
		t.Errorf("bad status: %d", r.status)
	}
	if r := do(t, ts, "POST", "/api/proposals/refunds/items", map[string]any{"kind": "frob"}); r.status != 400 {
		t.Errorf("bad kind: %d", r.status)
	}
	if r := do(t, ts, "PATCH", "/api/proposals/refunds/items/i9", map[string]any{"status": "done"}); r.status != 404 {
		t.Errorf("missing item: %d", r.status)
	}
	if r := do(t, ts, "POST", "/api/proposals/nope/items", map[string]any{"kind": "change"}); r.status != 404 {
		t.Errorf("missing proposal: %d", r.status)
	}
	if r := do(t, ts, "POST", "/api/proposals/refunds/items?rev=abc", map[string]any{"kind": "change"}); r.status != 405 {
		t.Errorf("at rev: %d", r.status)
	}
	// removing a key
	r = do(t, ts, "PATCH", "/api/proposals/refunds/items/i2", map[string]any{"reply": nil})
	b, _ = os.ReadFile(file)
	if r.status != 200 || strings.Contains(string(b), "TestPlace_ChargeFails") {
		t.Errorf("remove reply: %d\n%s", r.status, b)
	}

	// a whole-proposal PUT drops computed anchors
	st := getState(t, ts)
	refunds = refundsOf(st.Project.Proposals)
	if r := do(t, ts, "PUT", "/api/proposals/refunds", refunds, "If-Match", st.Versions["proposals/refunds"]); r.status != 200 {
		t.Fatalf("put: %d %s", r.status, r.body)
	}
	b, _ = os.ReadFile(file)
	if strings.Contains(string(b), "anchor") || strings.Count(string(b), "[[item]]") != 4 {
		t.Errorf("put wrote:\n%s", b)
	}

	// the code moves: the anchor follows the quote
	svc := filepath.Join(root, "internal/orders/service.go")
	src, _ := os.ReadFile(svc)
	os.WriteFile(svc, []byte(strings.Replace(string(src), "// Place reserves", "// one\n// two\n// Place reserves", 1)), 0o644)
	r = do(t, ts, "GET", "/api/proposals", nil)
	var list []*project.Proposal
	r.decode(t, &list)
	a = refundsOf(list).Items[0]["anchor"].(map[string]any)
	if l := a["lines"].([]any); l[0] != 54.0 || l[1] != 57.0 {
		t.Errorf("moved anchor: %v", a)
	}
}
