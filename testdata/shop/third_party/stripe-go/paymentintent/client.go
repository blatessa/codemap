// Package paymentintent is a minimal stand-in.
package paymentintent

import stripe "github.com/stripe/stripe-go/v79"

// Client creates payment intents.
type Client struct{ Key string }

// New creates a payment intent.
func (c *Client) New(params *stripe.PaymentIntentParams) (*stripe.PaymentIntent, error) {
	return &stripe.PaymentIntent{ID: "pi_test"}, nil
}
