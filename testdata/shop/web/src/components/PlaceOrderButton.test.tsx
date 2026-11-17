import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { PlaceOrderButton } from "./PlaceOrderButton";

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("../api", () => ({ createOrder: vi.fn().mockResolvedValue({ id: "o_1" }) }));

const twoWidgets = { items: [{ sku: "w-1", qty: 2, price: 500 }], setItems: () => {} };

test("navigates to the new order", async () => {
  render(<PlaceOrderButton cart={twoWidgets} />);
  await userEvent.click(screen.getByText("Place order"));
  expect(navigate).toHaveBeenCalledWith("/orders/o_1");
});
