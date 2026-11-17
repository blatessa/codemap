import { Layout } from "../components/Layout";
import { LoginForm } from "../components/LoginForm";

export function LoginPage() {
  return (
    <Layout title="Sign in">
      <LoginForm />
    </Layout>
  );
}
