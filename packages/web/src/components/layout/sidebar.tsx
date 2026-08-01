/**
 * components/layout/sidebar.tsx — 侧边导航
 *
 * 导航项：概览 / 持仓 / 交易 / 快照 / 收益分析 / 净值分析 / 账户 / 设置
 */

import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Briefcase,
  ArrowLeftRight,
  Camera,
  TrendingUp,
  LineChart,
  User,
  Settings,
} from 'lucide-react';
import { ROUTE_PATH } from '@/lib/constants';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: ROUTE_PATH.DASHBOARD, label: '概览', icon: LayoutDashboard },
  { to: ROUTE_PATH.HOLDINGS, label: '持仓', icon: Briefcase },
  { to: ROUTE_PATH.TRANSACTIONS, label: '交易', icon: ArrowLeftRight },
  { to: ROUTE_PATH.SNAPSHOTS, label: '快照', icon: Camera },
  { to: ROUTE_PATH.XIRR_ANALYSIS, label: '收益分析', icon: TrendingUp },
  { to: ROUTE_PATH.NAV_ANALYSIS, label: '净值分析', icon: LineChart },
  { to: ROUTE_PATH.ACCOUNT, label: '账户', icon: User },
  { to: ROUTE_PATH.SETTINGS, label: '设置', icon: Settings },
] as const;

export interface SidebarProps {
  className?: string;
  /** 移动端使用：点击导航项后关闭侧栏 */
  onNavigate?: () => void;
}

export function Sidebar({ className, onNavigate }: SidebarProps): JSX.Element {
  return (
    <nav className={cn('flex flex-col space-y-1 p-3', className)}>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
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
            <Icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
