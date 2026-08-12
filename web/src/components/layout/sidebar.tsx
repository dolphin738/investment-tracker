/**
 * components/layout/sidebar.tsx — 侧边导航
 *
 * 导航项（顺序固定，PRD §7）：概览 / 持仓 / 出入金 / 资产记录 / 收益分析 / 净值分析 / 账户 / 设置
 *
 * 「系统管理」为可折叠分组（仅管理员可见）：其下唯一子项「金融数据接口」链到
 * 金融数据接口管理页。折叠交互（展开/收起）发生在本主侧边栏，不在系统管理页内部。
 */

import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Briefcase,
  ArrowLeftRight,
  Camera,
  TrendingUp,
  LineChart,
  User,
  Settings,
  Shield,
  Database,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { ROUTE_PATH } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';

interface NavChild {
  to: string;
  label: string;
  icon: LucideIcon;
}

interface NavItem {
  to?: string;
  label: string;
  icon: LucideIcon;
  /** 仅管理员可见的导航项（如「系统管理」） */
  admin?: boolean;
  /** 存在子项时渲染为可折叠分组 */
  children?: NavChild[];
}

const NAV_ITEMS: NavItem[] = [
  { to: ROUTE_PATH.DASHBOARD, label: '概览', icon: LayoutDashboard },
  { to: ROUTE_PATH.HOLDINGS, label: '持仓', icon: Briefcase },
  { to: ROUTE_PATH.TRANSACTIONS, label: '出入金', icon: ArrowLeftRight },
  { to: ROUTE_PATH.SNAPSHOTS, label: '资产记录', icon: Camera },
  { to: ROUTE_PATH.XIRR_ANALYSIS, label: '收益分析', icon: TrendingUp },
  { to: ROUTE_PATH.NAV_ANALYSIS, label: '净值分析', icon: LineChart },
  { to: ROUTE_PATH.ACCOUNT, label: '账户', icon: User },
  { to: ROUTE_PATH.SETTINGS, label: '设置', icon: Settings },
  {
    label: '系统管理',
    icon: Shield,
    admin: true,
    children: [{ to: ROUTE_PATH.ADMIN, label: '金融数据接口', icon: Database }],
  },
];

export interface SidebarProps {
  className?: string;
  /** 移动端使用：点击导航项后关闭侧栏 */
  onNavigate?: () => void;
}

/** 可折叠分组：父级为切换按钮，子项缩进渲染于其下。 */
function NavGroup({
  item,
  onNavigate,
}: {
  item: NavItem;
  onNavigate?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<boolean>(true);
  const Icon = item.icon;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Icon className="h-4 w-4" />
        <span className="flex-1 text-left">{item.label}</span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
      </button>
      {open && (
        <div className="ml-3 mt-1 space-y-1 border-l pl-3">
          {item.children!.map((child) => {
            const ChildIcon = child.icon;
            return (
              <NavLink
                key={child.to}
                to={child.to}
                end={child.to === ROUTE_PATH.DASHBOARD}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )
                }
              >
                <ChildIcon className="h-4 w-4" />
                {child.label}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ className, onNavigate }: SidebarProps): JSX.Element {
  // 非管理员过滤掉 admin 标记的入口，避免越权可见（后端同样按 require_admin 拦截）
  const isAdmin = useIsAdmin();
  const visibleItems = NAV_ITEMS.filter((item) => !item.admin || isAdmin);
  return (
    <nav className={cn('flex flex-col space-y-1 p-3', className)}>
      {visibleItems.map((item) =>
        item.children ? (
          <NavGroup key={item.label} item={item} onNavigate={onNavigate} />
        ) : (
          <NavLink
            key={item.to}
            to={item.to!}
            end={item.to === ROUTE_PATH.DASHBOARD}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ),
      )}
    </nav>
  );
}
