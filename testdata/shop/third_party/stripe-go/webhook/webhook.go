// Package webhook is a minimal stand-in.
package webhook

import stripe "github.com/stripe/stripe-go/v79"

// ConstructEvent verifies a webhook payload and decodes it.
func ConstructEvent(payload []byte, header, secret string) (stripe.Event, error) {
	return stripe.Event{Data: &stripe.EventData{Object: map[string]any{}}}, nil
}
