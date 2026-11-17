module shop

go 1.23

require (
	github.com/go-chi/chi/v5 v5.1.0
	github.com/jackc/pgx/v5 v5.0.0
	github.com/mrz1836/postmark v1.0.0
	github.com/stripe/stripe-go/v79 v79.0.0
)

// Minimal stand-ins so the fixture builds offline. They keep the real import
// paths, because external-service detection keys on import paths.
replace (
	github.com/jackc/pgx/v5 => ./third_party/pgx
	github.com/mrz1836/postmark => ./third_party/postmark
	github.com/stripe/stripe-go/v79 => ./third_party/stripe-go
)
