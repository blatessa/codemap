import { http } from "./http";
import type { CartItem } from "../state/cart";

export type Order = { id: string; status: string; total: number };

/** POST /orders. Throws on a non-2xx response, via the shared http client. */
export async function createOrder(items: CartItem[]): Promise<Order> {
  const res = await http.post("/orders", { items });
  return res.json();
}

export async function getOrder(id: string): Promise<Order> {
  const res = await http.get(`/orders/${id}`);
  return res.json();
}
