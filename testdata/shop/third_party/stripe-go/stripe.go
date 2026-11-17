// Package stripe is a minimal stand-in for github.com/stripe/stripe-go/v79.
package stripe

// Int64 returns a pointer to v.
func Int64(v int64) *int64 { return &v }

// String returns a pointer to v.
func String(v string) *string { return &v }

// PaymentIntentParams are the parameters for creating a payment intent.
type PaymentIntentParams struct {
	Amount   *int64
	Currency *string
	Metadata map[string]string
}

// PaymentIntent is a payment intent.
type PaymentIntent struct{ ID string }

// Event is a webhook event.
type Event struct {
	Type string
	Data *EventData
}

// EventData holds the event's object.
type EventData struct{ Object map[string]any }
