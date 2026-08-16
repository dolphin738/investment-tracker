/**
 * components/route-persistence.tsx — 路由持久化（刷新保持当前页）
 *
 * 策略：URL 优先 + localStorage 兜底。
 * - 浏览器原生会在刷新时保留当前 URL，因此深链路径（如 /holdings）刷新后
 *   天然停留在原页，无需干预；
 * - 当网页以默认首页「/」落地（例如直接打开站点根路径）时，用 localStorage
 *   中记录的上次受保护路由做兜底回跳，避免每次都回到首页。
 *
 * 范式严格沿用 pages/admin.tsx：所有 localStorage 读写用 try/catch 包裹，
 * 脏值（不在白名单内的路由）一律忽略，静默丢弃隐私模式 / 配额失败。
 *
 * 该组件本身无渲染输出（返回 null），需挂载在能访问 router context 的位置
 * （当前在 AppLayout 内与 <Outlet/> 同层）。
 */

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LAST_ROUTE_KEY, ROUTE_PATH } from '@/lib/constants';

/**
 * 受保护路由白名单。
 * - PROTECTED_EXACT：精确匹配；
 * - PROTECTED_PREFIXES：前缀匹配（/analysis/ 下所有分析页）。
 * 仅白名单内的路由才允许被持久化 / 恢复，杜绝跳到未知或公开页。
 */
const PROTECTED_EXACT = [
  '/',
  '/holdings',
  '/cashflows',
  '/snapshots',
  '/analysis/xirr',
  '/analysis/nav',
  '/account',
  '/settings',
  '/admin',
];
const PROTECTED_PREFIXES = ['/analysis/'];

/** 校验「路由路径部分」是否在受保护白名单内（脏值忽略）。 */
function isValidPathname(pathname: string): boolean {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  if (PROTECTED_EXACT.includes(pathname)) return true;
  return PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** 读取上次路由：仅返回通过白名单校验的完整路径（含 query）。 */
function readStoredRoute(): string | null {
  try {
    const raw = localStorage.getItem(LAST_ROUTE_KEY);
    if (!raw) return null;
    // 持久化值为 `${pathname}${search}`，校验时取路径部分。
    const pathname = raw.split('?')[0];
    if (!isValidPathname(pathname)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 写入当前路由（含 query）。隐私模式 / 配额失败静默忽略。 */
function storeRoute(value: string): void {
  try {
    localStorage.setItem(LAST_ROUTE_KEY, value);
  } catch {
    /* 隐私模式 / 配额：忽略持久化失败 */
  }
}

/** 无需持久化的公开 / 历史别名路由。 */
const EXCLUDED_PATHNAMES = [ROUTE_PATH.LOGIN, ROUTE_PATH.REGISTER, '/transactions'];

/**
 * 无渲染组件：监听路由变化写入 localStorage，并在首页落地时兜底回跳。
 */
export function RoutePersistence(): null {
  const location = useLocation();
  const navigate = useNavigate();
  // 防止 React StrictMode / 开发双挂载导致重复回跳。
  const restored = useRef(false);

  // 写入端：pathname / search 变化时记录当前路由（排除公开与历史别名页）。
  useEffect(() => {
    const { pathname, search } = location;
    if (EXCLUDED_PATHNAMES.includes(pathname)) return;
    storeRoute(`${pathname}${search}`);
  }, [location.pathname, location.search]);

  // 恢复端：首次挂载时，若落在默认首页「/」，兜底回跳到上次受保护路由。
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (location.pathname !== '/') return;
    const saved = readStoredRoute();
    // 已在校验函数内排除脏值；此处再排除「首页本身」避免无意义 replace。
    if (saved && saved !== '/') {
      navigate(saved, { replace: true });
    }
  }, []);

  return null;
}
