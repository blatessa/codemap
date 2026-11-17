// Package sched runs functions on an interval.
package sched

import (
	"context"
	"log"
	"time"
)

// Scheduler runs named jobs.
type Scheduler struct{ ctx context.Context }

// New returns a scheduler bound to ctx.
func New(ctx context.Context) *Scheduler { return &Scheduler{ctx: ctx} }

// Every runs fn every interval until the scheduler's context is done.
func (s *Scheduler) Every(interval time.Duration, name string, fn func(context.Context) error) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-t.C:
				if err := fn(s.ctx); err != nil {
					log.Printf("job %s: %v", name, err)
				}
			}
		}
	}()
}
