package main

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codemap/internal/cli"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata/golden")

// runCmd runs a command and returns its stdout followed by its exit status and
// error message, which is what the golden files hold.
func runCmd(run func(io.Writer, []string) error, args []string) (string, int) {
	var out, errOut bytes.Buffer
	code := cli.Report(&errOut, run(&out, args))
	s := out.String()
	if code != 0 || errOut.Len() > 0 {
		s += fmt.Sprintf("--- exit %d\n%s", code, errOut.String())
	}
	return s, code
}

func checkGolden(t *testing.T, dir, name, got string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test ./cmd/codemap -update)", err)
	}
	if got != string(want) {
		t.Errorf("%s differs from golden file (run with -update to accept)\n--- got:\n%s\n--- want:\n%s", name, got, want)
	}
}

func goldenDir(t *testing.T) string {
	dir, err := filepath.Abs(filepath.Join("testdata", "golden"))
	if err != nil {
		t.Fatal(err)
	}
	if *update {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// TestQueryGolden runs the query commands against the shop fixture with the
// hand-written expected graph, in text and JSON form.
func TestQueryGolden(t *testing.T) {
	dir := goldenDir(t)
	t.Chdir(filepath.Join("..", "..", "testdata", "shop"))
	cases := []struct {
		name string
		run  func(io.Writer, []string) error
		args []string
		code int
	}{
		{"show-post-orders", runShow, []string{"POST /orders"}, 0},
		{"show-post-orders-code", runShow, []string{"POST /orders", "--detail", "code"}, 0},
		{"show-bad-detail", runShow, []string{"POST /orders", "--detail", "all"}, 2},
		{"show-get-order-brace", runShow, []string{"GET /orders/{id}", "--depth", "1"}, 0},
		{"show-checkout-depth3", runShow, []string{"page:/checkout", "--depth", "3"}, 0},
		{"show-page-path", runShow, []string{"/login", "--depth", "1"}, 0},
		{"show-function", runShow, []string{"orders.Service.Place"}, 0},
		{"show-external", runShow, []string{"ext:stripe", "--depth", "1"}, 0},
		{"show-ambiguous", runShow, []string{"NewHandler"}, 2},
		{"show-no-match", runShow, []string{"nothing-like-this"}, 1},
		{"callers-update-status", runCallers, []string{"Repo.UpdateStatus"}, 0},
		{"callers-place-depth1", runCallers, []string{"--depth", "1", "Service.Place"}, 0},
		{"callers-write-json-code", runCallers, []string{"writeJSON", "--detail", "code"}, 0},
		{"callers-route", runCallers, []string{"route:POST /orders"}, 0},
		{"callers-none", runCallers, []string{"server.main"}, 0},
		{"module-orders", runModule, []string{"internal/orders"}, 0},
		{"module-database", runModule, []string{"mod:sql:database"}, 0},
		{"search-refund", runSearch, []string{"refund"}, 0},
		{"search-transactional", runSearch, []string{"transactional"}, 0},
		{"search-limit", runSearch, []string{"orders", "--limit", "5"}, 0},
	}
	for _, tc := range cases {
		for _, asJSON := range []bool{false, true} {
			name, args := tc.name, append([]string{"--graph", "../shop.expected.json"}, tc.args...)
			if asJSON {
				name += ".json"
				args = append(args, "--json")
			}
			t.Run(name, func(t *testing.T) {
				got, code := runCmd(tc.run, args)
				if code != tc.code {
					t.Errorf("exit status %d, want %d\n%s", code, tc.code, got)
				}
				checkGolden(t, dir, name+".golden", got)
			})
		}
	}
}

func TestCommonFlagErrors(t *testing.T) {
	t.Chdir(filepath.Join("..", "..", "testdata", "shop"))
	// Without --graph the real extractors run, and should agree with the expected graph.
	real, code := runCmd(runShow, []string{"POST /orders"})
	want, _ := runCmd(runShow, []string{"POST /orders", "--graph", "../shop.expected.json"})
	if code != 0 || real != want {
		t.Errorf("extracted graph disagrees with the expected graph: exit %d\n%s", code, real)
	}
	got, code := runCmd(runShow, []string{"POST /orders", "--graph", "../shop.expected.json", "--rev", "HEAD"})
	if code != 1 || !strings.Contains(got, "can't be combined") {
		t.Errorf("--rev HEAD: exit %d\n%s", code, got)
	}
	_, code = runCmd(runShow, nil)
	if code != 2 {
		t.Errorf("no args: exit %d, want 2", code)
	}
}
