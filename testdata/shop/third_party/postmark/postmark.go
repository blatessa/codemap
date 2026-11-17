// Package postmark is a minimal stand-in for github.com/mrz1836/postmark.
package postmark

import "context"

// Client sends email.
type Client struct{ serverToken string }

// NewClient returns a client.
func NewClient(serverToken, accountToken string) *Client { return &Client{serverToken: serverToken} }

// TemplatedEmail is an email rendered from a server-side template.
type TemplatedEmail struct {
	TemplateAlias string
	To            string
	TemplateModel map[string]any
}

// EmailResponse is the API response.
type EmailResponse struct{ MessageID string }

// SendTemplatedEmail sends a templated email.
func (c *Client) SendTemplatedEmail(ctx context.Context, email TemplatedEmail) (EmailResponse, error) {
	return EmailResponse{}, nil
}
