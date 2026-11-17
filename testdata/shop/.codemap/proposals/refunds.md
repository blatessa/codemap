---
name: Refunds
status: open
updated: "2026-11-16"
nodes:
  - {id: new:RefundButton.onClick, kind: function, label: RefundButton.onClick, module: mod:ts:web/src/components}
  - {id: new:refundOrder, kind: function, label: refundOrder, module: mod:ts:web/src/api}
  - {id: "new:route:POST /orders/:id/refund", kind: route, label: /orders/:id/refund, module: mod:go:shop/cmd/server, entry: true, method: POST}
  - {id: new:orders.Service.Refund, kind: function, label: Service.Refund, module: mod:go:shop/internal/orders}
  - {id: new:payments.Client.Refund, kind: function, label: Client.Refund, module: mod:go:shop/internal/payments}
edges:
  - {from: "page:/orders/:id", to: new:RefundButton.onClick}
  - {from: new:RefundButton.onClick, to: new:refundOrder}
  - {from: new:refundOrder, to: "new:route:POST /orders/:id/refund"}
  - {from: "new:route:POST /orders/:id/refund", to: "go:shop/internal/auth.(*Handler).RequireUser"}
  - {from: "new:route:POST /orders/:id/refund", to: new:orders.Service.Refund}
  - {from: new:orders.Service.Refund, to: new:payments.Client.Refund}
  - {from: new:payments.Client.Refund, to: ext:stripe, detail: POST /v1/refunds}
  - {from: new:orders.Service.Refund, to: "go:shop/internal/orders.(*Repo).UpdateStatus"}
  - {from: new:orders.Service.Refund, to: topic:order.placed}
---
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
