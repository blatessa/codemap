package payments

import (
	"context"
	"io"
	"log"
	"net/http"

	stripe "github.com/stripe/stripe-go/v79"
	"github.com/stripe/stripe-go/v79/webhook"
)

// OrderMarker marks orders paid. orders.Service implements it.
type OrderMarker interface {
	MarkPaid(ctx context.Context, chargeID string) error
}

// Handler serves the Stripe webhook.
type Handler struct {
	orders OrderMarker
	secret string
}

// NewHandler returns a webhook handler.
func NewHandler(orders OrderMarker, secret string) *Handler {
	return &Handler{orders: orders, secret: secret}
}

// HandleWebhook receives Stripe events. It answers 200 once the signature checks out,
// so Stripe never retries a failed MarkPaid.
func (h *Handler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	ev, err := h.verifySignature(body, r.Header.Get("Stripe-Signature"))
	if err != nil {
		http.Error(w, "bad signature", http.StatusBadRequest)
		return
	}
	if ev.Type == "payment_intent.succeeded" {
		id, _ := ev.Data.Object["id"].(string)
		if err := h.orders.MarkPaid(r.Context(), id); err != nil {
			log.Printf("mark paid: %v", err) // still returns 200
		}
	}
	w.WriteHeader(http.StatusOK)
}

func (h *Handler) verifySignature(body []byte, sig string) (stripe.Event, error) {
	return webhook.ConstructEvent(body, sig, h.secret)
}
