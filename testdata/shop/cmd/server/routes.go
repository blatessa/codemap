package main

import (
	"github.com/go-chi/chi/v5"

	"shop/internal/auth"
	"shop/internal/orders"
	"shop/internal/payments"
)

func routes(r chi.Router, authH *auth.Handler, ordersH *orders.Handler, paymentsH *payments.Handler) {
	r.Post("/login", authH.Login)
	r.With(authH.RequireUser).Post("/orders", ordersH.Create)
	r.With(authH.RequireUser).Get("/orders/{id}", ordersH.Get)
	r.Post("/webhooks/stripe", paymentsH.HandleWebhook)
}
