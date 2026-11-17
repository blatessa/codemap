import { useQuery } from "@tanstack/react-query";
import * as api from "../api";

function useOrder(id: string) {
  return useQuery({
    queryKey: ["order", id],
    queryFn: () => api.getOrder(id),
    refetchInterval: 5000,
  });
}

export function OrderStatus({ id }: { id: string }) {
  const { data } = useOrder(id);
  return <p>{data ? data.status : "Loading…"}</p>;
}
