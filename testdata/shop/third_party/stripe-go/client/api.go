// Package client is a minimal stand-in.
package client

import "github.com/stripe/stripe-go/v79/paymentintent"

// API groups the Stripe resource clients.
type API struct{ PaymentIntents *paymentintent.Client }

// New returns an API client.
func New(key string) *API { return &API{PaymentIntents: &paymentintent.Client{Key: key}} }
