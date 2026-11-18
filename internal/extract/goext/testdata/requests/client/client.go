// Package client talks to the server's API.
package client

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

type Client struct {
	URL  string // http://host/<tenant>/api
	Base string // http://host
	HTTP *http.Client
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, body)
	if err != nil {
		return nil, err
	}
	return c.HTTP.Do(req)
}

func (c *Client) call(ctx context.Context, method, path string) error {
	resp, err := c.do(ctx, method, path, nil)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

func (c *Client) Tasks(ctx context.Context, all bool) error {
	q := ""
	if all {
		q = "?all=1"
	}
	return c.call(ctx, http.MethodGet, "/tasks"+q)
}

func (c *Client) CreateTask(ctx context.Context) error {
	return c.call(ctx, "POST", "/tasks")
}

func (c *Client) Task(ctx context.Context, id int64) error {
	return c.call(ctx, "GET", fmt.Sprintf("/tasks/%d", id))
}

// Approve matches both /tasks/{id}/approve and /tasks/{id}/{action}; the
// literal one wins.
func (c *Client) Approve(ctx context.Context, id int64) error {
	return c.call(ctx, "POST", fmt.Sprintf("/tasks/%d/approve", id))
}

func (c *Client) SetStatus(ctx context.Context, id int, action string) error {
	_, err := c.do(ctx, "POST", "/tasks/"+strconv.Itoa(id)+"/"+url.PathEscape(action), nil)
	return err
}

func (c *Client) User(ctx context.Context, name string) error {
	return c.call(ctx, "GET", "/users/"+name)
}

// withQuery builds a path: what it returns is its path parameter.
func withQuery(path string, active bool) string {
	if active {
		path = fmt.Sprintf("%s?%s", path, "active=1")
	}
	return path
}

func (c *Client) Users(ctx context.Context, active bool) error {
	return c.call(ctx, "GET", withQuery("/users", active))
}

func (c *Client) Me(ctx context.Context) error {
	return c.call(ctx, "GET", "/users/me")
}

// Health calls the server's health check directly, from the host's base URL.
func (c *Client) Health() error {
	u, err := url.Parse(c.Base + "/healthz")
	if err != nil {
		return err
	}
	_, err = c.HTTP.Get(u.String())
	return err
}

// Missing calls an endpoint the server doesn't have: no edge.
func (c *Client) Missing(ctx context.Context) error {
	return c.call(ctx, "DELETE", "/tasks")
}

// Wrong uses a method no route has for its path: no edge.
func (c *Client) Wrong(ctx context.Context) error {
	return c.call(ctx, "PUT", "/users/me")
}

// ProjectTasks agrees with GET /{tenant}/api/tasks only on "tasks": too
// little to count as a match.
func (c *Client) ProjectTasks(ctx context.Context, id int) error {
	return c.call(ctx, "GET", fmt.Sprintf("/projects/%d/tasks", id))
}

// Weather calls another service: an ext: edge, as before.
func Weather() error {
	_, err := http.Get("https://api.weather.example/v1/today")
	return err
}
