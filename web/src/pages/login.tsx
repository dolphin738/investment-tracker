/**
 * pages/login.tsx — 登录页
 */

import { LoginForm } from '@/features/auth/login-form';

export default function LoginPage(): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      <LoginForm />
    </div>
  );
}
