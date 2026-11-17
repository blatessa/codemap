// Package notify sends transactional email through Postmark.
package notify

import (
	"context"

	"github.com/mrz1836/postmark"
)

// Mailer sends customer email.
type Mailer struct{ postmark *postmark.Client }

// NewMailer returns a mailer using a Postmark server token.
func NewMailer(token string) *Mailer { return &Mailer{postmark: postmark.NewClient(token, "")} }

// SendReceipt emails a receipt once an order is paid.
func (m *Mailer) SendReceipt(ctx context.Context, to, orderID string, total int64) error {
	_, err := m.postmark.SendTemplatedEmail(ctx, postmark.TemplatedEmail{
		TemplateAlias: "receipt",
		To:            to,
		TemplateModel: map[string]any{"order_id": orderID, "total": total},
	})
	return err
}
