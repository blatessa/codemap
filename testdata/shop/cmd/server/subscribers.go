package main

import (
	"shop/internal/events"
	"shop/internal/notify"
)

func subscribers(bus *events.Bus, mailer *notify.Mailer) {
	bus.Subscribe("order.placed", mailer.SendConfirmation)
}
