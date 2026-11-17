import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { OrderStatus } from "../components/OrderStatus";

export function OrderPage() {
  const { id } = useParams();
  return (
    <Layout title="Your order">
      <OrderStatus id={id!} />
    </Layout>
  );
}
