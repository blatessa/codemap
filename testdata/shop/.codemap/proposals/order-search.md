---
name: Order search
status: archived
pr: "#57"
updated: "2026-10-30"
nodes:
  - {id: "new:route:GET /orders/search", kind: route, label: /orders/search, module: mod:go:shop/cmd/server, entry: true, method: GET}
  - {id: new:orders.Service.Search, kind: function, label: Service.Search, module: mod:go:shop/internal/orders}
edges:
  - {from: "new:route:GET /orders/search", to: "go:shop/internal/auth.(*Handler).RequireUser"}
  - {from: "new:route:GET /orders/search", to: new:orders.Service.Search}
  - {from: new:orders.Service.Search, to: table:orders, detail: "SELECT … WHERE items @> $1"}
---
Let a signed-in user search their past orders by item name.

> Shipped in #57 with a simple LIKE query. The index was left for later.
