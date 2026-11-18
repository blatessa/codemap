package goext

import (
	"strings"
	"testing"

	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// TestCallbacks checks that a helper calling a function it was passed doesn't
// get an edge to every function anyone passes it: the call belongs to the
// caller that passed it.
func TestCallbacks(t *testing.T) {
	g, err := Extract("testdata/callbacks", project.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range graph.Validate(g) {
		t.Error(e)
	}
	has := map[string]bool{}
	for _, e := range g.Edges {
		if e.Type == graph.Calls {
			has[strings.TrimPrefix(e.From, "go:callbacks/app.")+" -> "+strings.TrimPrefix(e.To, "go:callbacks/app.")] = true
		}
	}
	for _, w := range []string{
		"CreateIssue -> WithTx", "CreateIssue -> insertIssue",
		"DeleteRepo -> WithTx", "DeleteRepo -> deleteRepo",
		"WithTx -> txNoCheck", "txNoCheck -> begin",
		"MakePR -> WithTx2", "MakePR -> insertPR", "WithTx2 -> WithTx",
		"Sync -> Retry", "Sync -> syncMirror", // a named callback: from whoever passed it
		"Poke -> poked",                      // a closure: its calls are Poke's own
		"RunAll -> initA", "RunAll -> initB", // a list of functions isn't a parameter call
		"UpdateState -> WithTx", "UpdateState -> applyFull", "UpdateState -> applyPart",
		"Direct -> Run", "Direct -> handlerB",
		"ByName -> Run", "ByName -> handlerA", "ByName -> handlerB", // untraceable: everything Run was passed
	} {
		if !has[w] {
			t.Errorf("missing edge %s", w)
		}
	}
	for _, w := range []string{
		"WithTx -> CreateIssue", "WithTx -> DeleteRepo", "txNoCheck -> CreateIssue", "txNoCheck -> DeleteRepo",
		"WithTx -> WithTx2", "txNoCheck -> WithTx2", "WithTx2 -> MakePR", "WithTx -> MakePR",
		"Retry -> syncMirror", "WithTx -> UpdateState", "WithTx -> applyPart", "txNoCheck -> applyPart",
		"Dynamic -> Poke", "Run -> handlerA", "Run -> handlerB", "Direct -> handlerA",
	} {
		if has[w] {
			t.Errorf("unexpected edge %s", w)
		}
	}
}
