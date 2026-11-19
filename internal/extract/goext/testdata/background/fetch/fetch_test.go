package fetch

import (
	"net/http"
	"testing"
)

func TestForTests(t *testing.T) {
	_ = ForTests("http://example.test")
	_, _ = http.Get("http://" + t.Name())
}
