package orders

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/auth"
	"shop/internal/inventory"
	"shop/internal/payments"
)

type fakeInventory struct{ Err error }

func (f *fakeInventory) Reserve(ctx context.Context, items []inventory.Item) error { return f.Err }

type fakePayments struct{ Calls int }

func (f *fakePayments) Charge(ctx context.Context, userID string, cents int64) (*payments.Charge, error) {
	f.Calls++
	return &payments.Charge{ID: "ch_1"}, nil
}

type fakeEvents struct{}

func (fakeEvents) Publish(ctx context.Context, topic string, v any) {}

type fakeNotifier struct{}

func (fakeNotifier) SendReceipt(ctx context.Context, to, orderID string, total int64) error { return nil }

type fakes struct {
	inventory *fakeInventory
	payments  *fakePayments
}

func newTestService(t *testing.T) (*Service, fakes) {
	t.Helper()
	f := fakes{inventory: &fakeInventory{}, payments: &fakePayments{}}
	return NewService(NewRepo(&pgxpool.Pool{}), f.inventory, f.payments, fakeEvents{}, fakeNotifier{}), f
}

var (
	ctx        = context.Background()
	testUser   = &auth.User{ID: "u1", Email: "a@b.c"}
	twoWidgets = []inventory.Item{{SKU: "w-1", Qty: 2, Price: 500}}
)

func TestPlace_ChargesAndInserts(t *testing.T) {
	svc, fakes := newTestService(t)
	o, err := svc.Place(ctx, testUser, CreateOrder{Items: twoWidgets})
	if err != nil {
		t.Fatal(err)
	}
	if fakes.payments.Calls != 1 || o.Status != "pending" {
		t.Fatalf("unexpected order: %+v", o)
	}
}

func TestPlace_OutOfStock(t *testing.T) {
	svc, fakes := newTestService(t)
	fakes.inventory.Err = inventory.ErrOutOfStock{SKU: "w-1"}
	_, err := svc.Place(ctx, testUser, CreateOrder{Items: twoWidgets})
	if !errors.As(err, new(inventory.ErrOutOfStock)) {
		t.Fatalf("got %v, want ErrOutOfStock", err)
	}
	if fakes.payments.Calls != 0 {
		t.Fatal("charged a card for an out-of-stock order")
	}
}
