module wrapped

go 1.23

require github.com/go-chi/chi/v5 v5.0.0

// The signature-only chi stand-in the routers fixture uses.
replace github.com/go-chi/chi/v5 => ../routers/third_party/chi
