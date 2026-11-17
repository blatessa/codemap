import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import type { useCart } from "../state/cart";

type Props = { cart: ReturnType<typeof useCart> };

/**
 * Places the order and sends the user to its page.
 * The button stays disabled while the request is in flight.
 */
export function PlaceOrderButton({ cart }: Props) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function onClick() {
    setBusy(true);
    const order = await api.createOrder(cart.items);
    navigate(`/orders/${order.id}`);
  }
  return (
    <button onClick={onClick} disabled={busy}>
      Place order
    </button>
  );
}
