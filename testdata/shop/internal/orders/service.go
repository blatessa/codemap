package orders

import (
	"context"
	"fmt"

	"shop/internal/auth"
	"shop/internal/inventory"
	"shop/internal/payments"
)

// Inventory reserves stock.
type Inventory interface {
	Reserve(ctx context.Context, items []inventory.Item) error
}

// Payments charges cards.
type Payments interface {
	Charge(ctx context.Context, userID string, cents int64) (*payments.Charge, error)
}

// Events publishes domain events.
type Events interface {
	Publish(ctx context.Context, topic string, v any)
}

// Notifier emails customers.
type Notifier interface {
	SendReceipt(ctx context.Context, to, orderID string, total int64) error
}

// Service places and pays orders.
type Service struct {
	repo      *Repo
	inventory Inventory
	payments  Payments
	events    Events
	notify    Notifier
}

// NewService returns a service.
func NewService(repo *Repo, inv Inventory, pay Payments, ev Events, n Notifier) *Service {
	return &Service{repo: repo, inventory: inv, payments: pay, events: ev, notify: n}
}

// Place reserves stock, charges the card and saves the order, in that order.
// If the charge fails, the reservation is left for the expire-carts job to release.
func (s *Service) Place(ctx context.Context, u *auth.User, req CreateOrder) (*Order, error) {
	if err := s.inventory.Reserve(ctx, req.Items); err != nil {
		return nil, fmt.Errorf("reserve: %w", err)
	}
	charge, err := s.payments.Charge(ctx, u.ID, req.Total())
	if err != nil {
		return nil, fmt.Errorf("charge: %w", err)
	}
	o := &Order{UserID: u.ID, UserEmail: u.Email, Items: req.Items, ChargeID: charge.ID, Status: "pending", Total: req.Total()}
	if err := s.repo.Insert(ctx, o); err != nil {
		return nil, err
	}
	s.events.Publish(ctx, "order.placed", o)
	return o, nil
}

// MarkPaid is called from the Stripe webhook once a payment succeeds.
func (s *Service) MarkPaid(ctx context.Context, chargeID string) error {
	o, err := s.repo.UpdateStatus(ctx, chargeID, "paid")
	if err != nil {
		return err
	}
	return s.notify.SendReceipt(ctx, o.UserEmail, o.ID, o.Total)
}
