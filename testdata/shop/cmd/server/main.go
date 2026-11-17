// Command server runs the shop API.
package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/auth"
	"shop/internal/events"
	"shop/internal/inventory"
	"shop/internal/notify"
	"shop/internal/orders"
	"shop/internal/payments"
	"shop/internal/sched"
)

type logConn struct{}

func (logConn) Publish(subject string, data []byte) error {
	log.Printf("publish %s %s", subject, data)
	return nil
}

func main() {
	ctx := context.Background()
	db, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	bus := events.NewBus(logConn{})
	mailer := notify.NewMailer(os.Getenv("POSTMARK_TOKEN"))
	inv := inventory.NewStore(db)
	pay := payments.NewClient(os.Getenv("STRIPE_SECRET_KEY"))
	repo := orders.NewRepo(db)
	svc := orders.NewService(repo, inv, pay, bus, mailer)

	r := chi.NewRouter()
	routes(r, auth.NewHandler(db, []byte(os.Getenv("TOKEN_SECRET"))), orders.NewHandler(svc, repo),
		payments.NewHandler(svc, os.Getenv("STRIPE_WEBHOOK_SECRET")))
	jobs(sched.New(ctx), inv)
	subscribers(bus, mailer)

	log.Fatal(http.ListenAndServe(":8080", r))
}
