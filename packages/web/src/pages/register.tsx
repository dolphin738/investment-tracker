/**
 * pages/register.tsx — 注册页
 */

import { RegisterForm } from '@/features/auth/register-form';

export default function RegisterPage(): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      <RegisterForm />
    </div>
  );
}
