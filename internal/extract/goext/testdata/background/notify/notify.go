// Package notify pushes messages to user-configured webhooks.
package notify

import (
	"net/http"
	"strings"
)

// Client posts to a webhook URL it was configured with.
type Client struct {
	webhookURL string
	http       *http.Client
}

func New(webhookURL string) *Client { return &Client{webhookURL: webhookURL, http: &http.Client{}} }

// Send makes the request with client.Do; its callers keep the client in a
// variable, so the request is Send's.
func (c *Client) Send(msg string) error {
	req, err := http.NewRequest(http.MethodPost, c.webhookURL, strings.NewReader(msg))
	if err != nil {
		return err
	}
	_, err = c.http.Do(req)
	return err
}

func Notify(url, msg string) error {
	c := New(url)
	return c.Send(msg)
}

// builder builds a request in one expression.
type builder struct {
	endpoint, method string
}

func Request(endpoint string) *builder { return &builder{endpoint: endpoint, method: http.MethodGet} }

func (b *builder) WithMethod(m string) *builder { b.method = m; return b }

func (b *builder) Do() error {
	req, err := http.NewRequest(b.method, b.endpoint, nil)
	if err != nil {
		return err
	}
	_, err = http.DefaultClient.Do(req)
	return err
}

type Settings struct{ ChatURL, HookURL string }

// Chat builds and sends a request in one expression: its request.
func Chat(s Settings) error {
	return Request(s.ChatURL).WithMethod(http.MethodPut).Do()
}

// Hook does the same with the builder's default method.
func Hook(s Settings) error {
	return Request(s.HookURL).Do()
}

// APIBase is the server's base URL, set at startup.
var APIBase string

// Items calls the repo's own API: a fetches edge, nothing external.
func Items() error {
	_, err := http.Get(APIBase + "/api/items")
	return err
}

// Local calls a server on this machine: nothing.
func Local(port string) error {
	_, err := http.Get("http://localhost:" + port + "/metrics")
	return err
}
