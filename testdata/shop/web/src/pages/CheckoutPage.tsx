import { Layout } from "../components/Layout";
import { PlaceOrderButton } from "../components/PlaceOrderButton";
import { useCart } from "../state/cart";

export function CheckoutPage() {
  const cart = useCart();
  return (
    <Layout title="Checkout">
      <ul>
        {cart.items.map((it) => (
          <li key={it.sku}>
            {it.qty} × {it.sku}
          </li>
        ))}
      </ul>
      <PlaceOrderButton cart={cart} />
    </Layout>
  );
}
