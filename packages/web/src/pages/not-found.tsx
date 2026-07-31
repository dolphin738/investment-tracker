/**
 * pages/not-found.tsx — 404 页
 */

import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ROUTE_PATH } from '@/lib/constants';

export default function NotFoundPage(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-4">
      <h1 className="text-6xl font-bold text-muted-foreground">404</h1>
      <p className="text-sm text-muted-foreground">页面未找到</p>
      <Button asChild>
        <Link to={ROUTE_PATH.DASHBOARD}>返回首页</Link>
      </Button>
    </div>
  );
}
