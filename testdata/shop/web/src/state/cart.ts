import { useState } from "react";

export type CartItem = { sku: string; qty: number; price: number };

export function useCart() {
  const [items, setItems] = useState<CartItem[]>([{ sku: "w-1", qty: 2, price: 500 }]);
  return { items, setItems };
}
