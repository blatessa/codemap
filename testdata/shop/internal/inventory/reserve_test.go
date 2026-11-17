package inventory

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestReserve_InsufficientStock(t *testing.T) {
	s := NewStore(&pgxpool.Pool{})
	err := s.Reserve(context.Background(), []Item{{SKU: "w-1", Qty: 2}})
	if !errors.As(err, new(ErrOutOfStock)) {
		t.Fatalf("got %v, want ErrOutOfStock", err)
	}
}
