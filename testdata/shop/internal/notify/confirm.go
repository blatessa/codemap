package notify

import (
	"context"
	"encoding/json"

	"github.com/mrz1836/postmark"
)

type orderPlaced struct {
	ID    string `json:"id"`
	Email string `json:"user_email"`
}

// SendConfirmation emails the customer when an order is placed, before payment clears.
func (m *Mailer) SendConfirmation(ctx context.Context, msg []byte) error {
	var o orderPlaced
	if err := json.Unmarshal(msg, &o); err != nil {
		return err
	}
	_, err := m.postmark.SendTemplatedEmail(ctx, postmark.TemplatedEmail{TemplateAlias: "confirmation", To: o.Email})
	return err
}
