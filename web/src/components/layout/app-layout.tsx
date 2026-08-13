/**
 * components/layout/app-layout.tsx — 主布局
 *
 * 顶部导航栏（Logo + 组合选择 + 用户菜单）+ 侧边导航 + 内容区。
 * 响应式：桌面侧栏常驻，移动端折叠为汉堡菜单。
 */

import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { CalendarDays, LogOut, Menu, Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sidebar } from './sidebar';
import { PortfolioSelector } from '@/features/portfolio/portfolio-selector';
import { PortfolioDialog } from '@/features/portfolio/portfolio-dialog';
import { useAuthStore, useIsAdmin } from '@/stores/auth.store';
import { NotificationBell } from '@/features/admin/notification-bell';
import { ROUTE_PATH, nowInAppTzIso } from '@/lib/constants';

/**
 * BaselineClock — 顶栏「项目基准时间」实时时钟。
 *
 * 显示北京时间（UTC+8）的「日期 + 时间」(YYYY-MM-DD HH:mm:ss)，
 * 每秒刷新一次。使用独立 useState/useEffect，仅重渲该 span，
 * 不波及其它顶栏组件，避免不必要的全局重渲。
 * 复用 lib/constants.nowInAppTzIso()（位移 +8h 仅配 toISOString，绝不混
 * 入 getTimezoneOffset），保证时区鲁棒性。
 */
function BaselineClock(): JSX.Element {
  const [now, setNow] = useState<string>(() => nowInAppTzIso());

  useEffect(() => {
    setNow(nowInAppTzIso());
    const timer = window.setInterval(() => {
      setNow(nowInAppTzIso());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      className="hidden items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground sm:flex"
      title="项目基准日期时间（北京时间 UTC+8）"
    >
      <CalendarDays className="h-3.5 w-3.5" />
      {now}
    </span>
  );
}

export function AppLayout(): JSX.Element {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const isAdmin = useIsAdmin();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [portfolioDialogOpen, setPortfolioDialogOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate(ROUTE_PATH.LOGIN);
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* 顶部导航栏 */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="切换导航"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight">投资收益统计</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <BaselineClock />
          <PortfolioSelector onCreateClick={() => setPortfolioDialogOpen(true)} />
          {isAdmin && <NotificationBell />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="flex h-9 items-center gap-2 px-2"
                aria-label="用户菜单"
              >
                <UserAvatar
                  size="sm"
                  src={user?.avatar}
                  name={user?.name}
                  email={user?.email ?? ''}
                />
                <span className="hidden max-w-[8rem] truncate text-sm md:inline">
                  {user?.name || user?.email || '用户'}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex items-center gap-2">
                  <UserAvatar
                    size="sm"
                    src={user?.avatar}
                    name={user?.name}
                    email={user?.email ?? ''}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">
                      {user?.name || user?.email || '用户'}
                    </span>
                    {user?.email && (
                      <span className="truncate text-xs font-normal text-muted-foreground">
                        {user.email}
                      </span>
                    )}
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => navigate(ROUTE_PATH.SETTINGS)}
              >
                <Settings className="mr-2 h-4 w-4" />
                设置
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex flex-1">
        {/* 侧边导航：桌面常驻 */}
        <aside className="hidden w-[200px] shrink-0 border-r bg-card md:block">
          <Sidebar />
        </aside>

        {/* 移动端侧栏：条件渲染 */}
        {mobileOpen && (
          <div className="fixed inset-0 z-20 md:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setMobileOpen(false)}
            />
            <aside className="absolute left-0 top-0 h-full w-[240px] border-r bg-card">
              <Sidebar onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        )}

        {/* 主内容区 */}
        <main className="flex-1 overflow-x-hidden p-4 md:p-6">
          <Outlet />
        </main>
      </div>

      {/* 新建组合对话框 */}
      <PortfolioDialog
        open={portfolioDialogOpen}
        onOpenChange={setPortfolioDialogOpen}
      />
    </div>
  );
}
