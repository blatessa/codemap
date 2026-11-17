// Package events publishes domain events to the message queue.
package events

import (
	"context"
	"encoding/json"
	"log"
)

// Conn is a connection to the queue (NATS in production).
type Conn interface {
	Publish(subject string, data []byte) error
}

// Handler handles one message.
type Handler func(ctx context.Context, msg []byte) error

// Bus publishes and subscribes to topics.
type Bus struct {
	conn Conn
	subs map[string][]Handler
}

// NewBus returns a bus on conn.
func NewBus(conn Conn) *Bus { return &Bus{conn: conn, subs: map[string][]Handler{}} }

// Publish sends v to topic. Failures are logged, not returned: events are best-effort.
func (b *Bus) Publish(ctx context.Context, topic string, v any) {
	data, _ := json.Marshal(v)
	if err := b.conn.Publish(topic, data); err != nil {
		log.Printf("publish %s: %v", topic, err)
	}
}

// Subscribe registers h for messages on topic.
func (b *Bus) Subscribe(topic string, h Handler) {
	b.subs[topic] = append(b.subs[topic], h)
}
