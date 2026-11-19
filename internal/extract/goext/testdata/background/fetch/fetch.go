// Package fetch downloads URLs known only at run time.
package fetch

import (
	"io"
	"net/http"
)

var client = &http.Client{}

// get makes the request; its callers decide the URL.
func get(u string) (*http.Response, error) {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	return client.Do(req)
}

// Download passes its URL on: still not the one deciding it.
func Download(u string) ([]byte, error) {
	resp, err := get(u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

type Feed struct{ URL string }

// Refresh downloads a feed from its stored URL: the edge lands here.
func Refresh(f Feed) error {
	_, err := Download(f.URL)
	return err
}

// Version asks a fixed host through the same helpers: ext:<host>.
func Version() error {
	_, err := Download("https://api.example.com/v1/version")
	return err
}

// Probe is never called from repo code: it makes its request itself.
func Probe(u string) error {
	resp, err := http.Head(u)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// Ping calls a constant URL directly, as before.
func Ping() error {
	_, err := http.Get("https://status.example.com/ping")
	return err
}

// ForTests is only called by tests: no edge.
func ForTests(u string) error {
	_, err := http.Get(u + "/x")
	return err
}
