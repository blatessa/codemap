package web

import (
	"io/fs"
	"strings"
	"testing"
)

func TestDistIsBuilt(t *testing.T) {
	b, err := fs.ReadFile(Dist, "dist/index.html")
	if err != nil {
		t.Fatalf("viewer not built into internal/web/dist (run npm run build in viewer/): %v", err)
	}
	if !strings.Contains(string(b), "assets/") {
		t.Errorf("index.html does not reference built assets")
	}
}
