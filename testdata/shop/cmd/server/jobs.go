package main

import (
	"time"

	"shop/internal/inventory"
	"shop/internal/sched"
)

func jobs(s *sched.Scheduler, inv *inventory.Store) {
	s.Every(15*time.Minute, "expire-carts", inv.ReleaseExpired)
}
