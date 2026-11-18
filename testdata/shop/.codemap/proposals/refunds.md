+++
name = 'Refunds'
status = 'open'
updated = '2026-11-16'

[[node]]
id = 'new:RefundButton.onClick'
kind = 'function'
label = 'RefundButton.onClick'
module = 'mod:ts:web/src/components'

[[node]]
id = 'new:refundOrder'
kind = 'function'
label = 'refundOrder'
module = 'mod:ts:web/src/api'

[[node]]
id = 'new:route:POST /orders/:id/refund'
kind = 'route'
label = '/orders/:id/refund'
module = 'mod:go:shop/cmd/server'
entry = true
method = 'POST'

[[node]]
id = 'new:orders.Service.Refund'
kind = 'function'
label = 'Service.Refund'
module = 'mod:go:shop/internal/orders'

[[node]]
id = 'new:payments.Client.Refund'
kind = 'function'
label = 'Client.Refund'
module = 'mod:go:shop/internal/payments'

[[edge]]
from = 'page:/orders/:id'
to = 'new:RefundButton.onClick'

[[edge]]
from = 'new:RefundButton.onClick'
to = 'new:refundOrder'

[[edge]]
from = 'new:refundOrder'
to = 'new:route:POST /orders/:id/refund'

[[edge]]
from = 'new:route:POST /orders/:id/refund'
to = 'go:shop/internal/auth.(*Handler).RequireUser'

[[edge]]
from = 'new:route:POST /orders/:id/refund'
to = 'new:orders.Service.Refund'

[[edge]]
from = 'new:orders.Service.Refund'
to = 'new:payments.Client.Refund'

[[edge]]
from = 'new:payments.Client.Refund'
to = 'ext:stripe'
detail = 'POST /v1/refunds'

[[edge]]
from = 'new:orders.Service.Refund'
to = 'go:shop/internal/orders.(*Repo).UpdateStatus'

[[edge]]
from = 'new:orders.Service.Refund'
to = 'topic:order.placed'
+++
## Why
Support refunds orders by hand in the Stripe dashboard, so the `orders` table never learns about it.

## Shape
- **RefundButton** on the order page, support role only.
- `POST /orders/:id/refund` goes through `RequireUser` like the other order routes.
- `orders.Service.Refund` owns the rules; `payments.Client.Refund` only talks to Stripe.
- Reuse `Repo.UpdateStatus` for the status change.

## Open questions
1. Partial refunds now or later?
2. Should the webhook confirm the refund instead of trusting the API response?
