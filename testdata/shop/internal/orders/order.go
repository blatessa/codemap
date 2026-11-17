// Package orders owns the order lifecycle: placing, paying and looking up orders.
package orders

import "shop/internal/inventory"

// Order is a customer's order. It is also the order.placed message.
type Order struct {
	ID        string           `json:"id"`
	UserID    string           `json:"user_id"`
	UserEmail string           `json:"user_email"`
	Items     []inventory.Item `json:"items"`
	ChargeID  string           `json:"charge_id"`
	Status    string           `json:"status"`
	Total     int64            `json:"total"`
}

// CreateOrder is the request body for POST /orders.
type CreateOrder struct {
	Items []inventory.Item `json:"items"`
}

// Total returns the order total in cents.
func (c CreateOrder) Total() int64 {
	var t int64
	for _, it := range c.Items {
		t += it.Price * int64(it.Qty)
	}
	return t
}
