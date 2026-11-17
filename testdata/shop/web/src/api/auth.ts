import { http } from "./http";

export async function login(email: string, password: string) {
  const res = await http.post("/login", { email, password });
  return res.json() as Promise<{ token: string }>;
}
