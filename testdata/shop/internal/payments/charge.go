// Package payments wraps Stripe. Nothing outside this package imports the Stripe SDK.
package payments

import (
	"context"

	stripe "github.com/stripe/stripe-go/v79"
	"github.com/stripe/stripe-go/v79/client"
)

// Charge is a created payment.
type Charge struct{ ID string }

// Client charges cards.
type Client struct{ stripe *client.API }

// NewClient returns a client using key.
func NewClient(key string) *Client { return &Client{stripe: client.New(key)} }

// Charge creates a payment intent for cents on behalf of userID.
func (c *Client) Charge(ctx context.Context, userID string, cents int64) (*Charge, error) {
	pi, err := c.stripe.PaymentIntents.New(&stripe.PaymentIntentParams{
		Amount:   stripe.Int64(cents),
		Currency: stripe.String("usd"),
		Metadata: map[string]string{"user_id": userID},
	})
	if err != nil {
		return nil, err
	}
	return &Charge{ID: pi.ID}, nil
}
