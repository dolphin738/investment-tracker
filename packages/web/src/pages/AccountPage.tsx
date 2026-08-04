/**
 * pages/AccountPage.tsx — 账户中心（PRD v3.1.8 §7.7：账户页 = 看，纯只读聚合视图）
 *
 * 四张只读卡（草图逐项对齐）：
 * - 👤 个人信息（ACC-P0-02）：头像 / 昵称 / 邮箱 / 手机（脱敏）/ 简介 / 注册时间，卡内零修改控件
 * - 📊 资产全景（ACC-P0-03）：组合数 / 合计总资产 / 合计净投入 / 合计浮动盈亏
 * - 📈 数据统计（ACC-P0-06）：出入金笔数 / 证券买卖笔数 / 总资产记录天数 / 数据区间 / 账户使用天数
 * - 💼 我的组合（ACC-P0-04）：点击行 = 切换组合并跳转概览；右上 [+新建组合]
 *
 * 账户页保留「+新建组合」快捷入口（复用 PortfolioDialog 打开新建组合弹窗）；
 * 完整的组合管理（设为默认 / 归档 / 删除）在设置页 `/settings` 的组合管理区。
 * 退出登录、注销账户等其余修改入口同样在设置页（ACC-P0-05）。
 *
 * 数据来源（T03 接真值后，组合列表以 summary 为单一数据源，不再用 usePortfolios 兜底）：
 * - GET /api/auth/profile        — 用户信息（优先于 auth store，避免旧 localStorage 缓存缺 createdAt）
 * - GET /api/account/stats       — 账户统计（cashflowCount / tradeCount）
 * - GET /api/portfolios/summary  — 资产全景（跨组合）+ 组合列表（成立日 / 币种 / 净值 / 当年% / 净投入 / 浮动盈亏）
 *
 * 金融口径约定：金额/净值/收益率以 string 跨网；「无数据」为 null，渲染「—」或「未成立」，
 * 禁止把 null 渲染成 0（SYS-P0-05 四态）。跨组合仅做金额类求和（Q-07：不做合计 XIRR / 合计净值）。
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightLeft,
  Calendar,
  CalendarRange,
  Clock,
  LineChart,
  Mail,
  Phone,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CardSkeleton } from '@/components/LoadingSpinner';
import { PageHeader } from '@/components/PageHeader';
import { UserAvatar } from '@/components/user-avatar';
import { PortfolioDialog } from '@/features/portfolio/portfolio-dialog';
import { useAuthStore } from '@/stores/auth.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { useProfile } from '@/hooks/use-auth';
import { getAccountStats } from '@/api/account.api';
import { getPortfoliosSummary } from '@/api/overview.api';
import { ROUTE_PATH } from '@/lib/constants';
import { formatCurrency, formatDate, formatDecimal, formatPercent } from '@/lib/utils';

/** 无数据统一占位符（SYS-P0-05 四态：缺数据不白屏、不伪造；null 是「无数据」不是 0） */
const NO_DATA = '—';

/** 手机号脱敏 */
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '-';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 统计卡单元格 */
function StatTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: JSX.Element;
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
      {icon}
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-lg font-bold tabular-nums">{value}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export default function AccountPage(): JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const profile = useProfile();
  const setCurrentPortfolio = usePortfolioStore((s) => s.setCurrentPortfolio);
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);

  /** [+新建组合]：复用设置页同款 PortfolioDialog，保持创建体验一致 */
  const [creating, setCreating] = useState<boolean>(false);

  const stats = useQuery({
    queryKey: ['account', 'stats'],
    queryFn: () => getAccountStats(),
    staleTime: 60 * 1000,
  });
  const summary = useQuery({
    queryKey: ['portfolios', 'summary'],
    queryFn: () => getPortfoliosSummary(),
    staleTime: 60 * 1000,
  });

  /** 合计总资产：仅做金额类求和（Q-07：不做跨组合合计 XIRR / 合计净值） */
  const totalAsset = useMemo(() => {
    if (!summary.data) return 0;
    return summary.data.reduce(
      (sum, p) => sum + (Number.parseFloat(p.totalAsset || '0') || 0),
      0,
    );
  }, [summary.data]);

  /** 合计净投入：Σ netInvested（金额类求和 · Q-07 豁免；netInvested 必填，无出入金为 '0.00'） */
  const totalNetInvested = useMemo(() => {
    if (!summary.data) return 0;
    return summary.data.reduce(
      (sum, p) => sum + (Number.parseFloat(p.netInvested || '0') || 0),
      0,
    );
  }, [summary.data]);

  /**
   * 合计浮动盈亏：Σ floatingProfit，跳过 null —— 无总资产快照的组合不参与合计，
   * 避免把「无数据」当作 0 拉低合计（后端 floatingProfit 为 null 时本就无快照可算）。
   * 全部组合都无快照时返回 null → 渲染「—」。
   */
  const totalFloatingProfit = useMemo(() => {
    if (!summary.data) return null;
    let sum = 0;
    let hasAny = false;
    for (const p of summary.data) {
      if (p.floatingProfit != null) {
        sum += Number.parseFloat(p.floatingProfit) || 0;
        hasAny = true;
      }
    }
    return hasAny ? sum : null;
  }, [summary.data]);

  /**
   * 无总资产记录的组合数：后端无快照时 totalAsset 返回 '0'，
   * 这里以「金额为 0 且无更新日」判定，避免把真实 0 资产组合误判为无记录。
   */
  const missingAssetCount = useMemo(() => {
    if (!summary.data) return 0;
    return summary.data.filter(
      (p) => !(Number.parseFloat(p.totalAsset || '0') > 0) && !p.lastUpdatedAt,
    ).length;
  }, [summary.data]);

  /** 点击组合行：切换当前组合并跳转概览（ACC-P0-04） */
  const handleOpenPortfolio = (portfolioId: string): void => {
    if (portfolioId !== currentPortfolioId) {
      setCurrentPortfolio(portfolioId);
    }
    navigate(ROUTE_PATH.DASHBOARD);
  };

  // 优先用 GET /auth/profile 的新鲜响应：auth store 从 localStorage 恢复的旧缓存
  // user 可能缺 createdAt（后端补投影前的旧缓存），profile.data 恒为最新服务端数据。
  const currentUser = profile.data ?? user;
  const isLoading = !currentUser && profile.isLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="账户" />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
          <CardSkeleton className="xl:col-span-4" />
          <CardSkeleton className="xl:col-span-4" />
          <CardSkeleton className="xl:col-span-4" />
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="flex flex-col items-center gap-4 py-10">
          <p className="text-sm text-muted-foreground">用户信息加载失败</p>
          <Button variant="outline" onClick={() => profile.refetch()}>
            重新加载
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="账户"
        description="账户中心 · 纯只读聚合视图（修改入口见设置页）"
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* ===== 个人信息（只读 · ACC-P0-02） ===== */}
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">个人信息</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <UserAvatar
              src={currentUser.avatar}
              name={currentUser.name}
              email={currentUser.email}
              size="lg"
            />
            <div className="w-full space-y-2 text-center">
              <h3 className="text-lg font-semibold">
                {currentUser.name || '未设置昵称'}
              </h3>
              <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                <Mail className="h-3.5 w-3.5" />
                {currentUser.email}
              </div>
              <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                <Phone className="h-3.5 w-3.5" />
                {maskPhone(currentUser.phone)}
              </div>
              <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" />
                注册于 {formatDate(currentUser.createdAt)}
              </div>
              {currentUser.bio && (
                <p className="text-sm text-muted-foreground">{currentUser.bio}</p>
              )}
            </div>
            {/* 卡内无任何修改控件（§7.7 L1320-1322），仅提供跳转 */}
            <Button
              variant="link"
              size="sm"
              className="mt-auto"
              onClick={() => navigate(ROUTE_PATH.SETTINGS)}
            >
              前往设置修改 →
            </Button>
          </CardContent>
        </Card>

        {/* ===== 资产全景（ACC-P0-03） ===== */}
        <Card className="xl:col-span-5">
          <CardHeader>
            <CardTitle className="text-base">资产全景</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <div className="grid grid-cols-2 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                    <div className="h-6 w-24 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : summary.data && summary.data.length > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">组合数</p>
                    <p className="text-xl font-bold tabular-nums">
                      {summary.data.length}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">合计总资产</p>
                    <p className="text-xl font-bold tabular-nums">
                      ¥{formatCurrency(totalAsset)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">合计净投入</p>
                    <p className="text-xl font-bold tabular-nums">
                      ¥{formatCurrency(totalNetInvested)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">合计浮动盈亏</p>
                    <p className="text-xl font-bold tabular-nums">
                      {totalFloatingProfit != null
                        ? `¥${formatCurrency(totalFloatingProfit)}`
                        : NO_DATA}
                    </p>
                  </div>
                </div>
                <div className="mt-4 space-y-1 text-xs text-muted-foreground">
                  {missingAssetCount > 0 && (
                    <p>ⓘ {missingAssetCount} 个组合暂无总资产记录，未计入合计</p>
                  )}
                  <p>ⓘ 仅做金额类求和；不做跨组合合计 XIRR / 合计净值（Q-07）</p>
                </div>
              </>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                暂无组合数据
              </p>
            )}
          </CardContent>
        </Card>

        {/* ===== 数据统计（ACC-P0-06） ===== */}
        <Card className="xl:col-span-4">
          <CardHeader>
            <CardTitle className="text-base">数据统计</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.isLoading ? (
              <div className="grid grid-cols-2 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                    <div className="h-6 w-24 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : stats.data ? (
              <div className="grid grid-cols-2 gap-4">
                {/* 出入金笔数（CashFlow 计数） */}
                <StatTile
                  icon={
                    <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
                  }
                  label="出入金笔数"
                  value={String(stats.data.cashflowCount)}
                />
                {/* 证券买卖笔数（SecurityTrade 计数） */}
                <StatTile
                  icon={<LineChart className="h-5 w-5 text-muted-foreground" />}
                  label="证券买卖笔数"
                  value={String(stats.data.tradeCount)}
                />
                <StatTile
                  icon={
                    <CalendarRange className="h-5 w-5 text-muted-foreground" />
                  }
                  label="总资产记录天数"
                  value={String(stats.data.snapshotDays)}
                />
                <StatTile
                  icon={<Clock className="h-5 w-5 text-muted-foreground" />}
                  label="账户使用天数"
                  value={String(stats.data.recordDays)}
                />
                {stats.data.firstDate && (
                  <StatTile
                    icon={<Calendar className="h-5 w-5 text-muted-foreground" />}
                    label="起始日期"
                    value={formatDate(stats.data.firstDate)}
                  />
                )}
                {stats.data.lastDate && (
                  <StatTile
                    icon={<Calendar className="h-5 w-5 text-muted-foreground" />}
                    label="最近日期"
                    value={formatDate(stats.data.lastDate)}
                  />
                )}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                暂无统计数据
              </p>
            )}
          </CardContent>
        </Card>

        {/* ===== 我的组合（ACC-P0-04 · 7 列表格独占整行，不可挤 1/3 宽） ===== */}
        <Card className="xl:col-span-12">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">我的组合</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <Plus className="mr-2 h-4 w-4" />
              新建组合
            </Button>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-9 animate-pulse rounded bg-muted" />
                ))}
              </div>
            ) : summary.data && summary.data.length > 0 ? (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>组合名称</TableHead>
                      <TableHead>成立日</TableHead>
                      <TableHead>币种</TableHead>
                      <TableHead className="text-right">最新总资产</TableHead>
                      <TableHead className="text-right">净值</TableHead>
                      <TableHead className="text-right">当年%</TableHead>
                      <TableHead>更新日</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.data.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">
                          <button
                            type="button"
                            className="text-left hover:underline"
                            onClick={() => handleOpenPortfolio(p.id)}
                            title="切换到该组合并跳转概览"
                          >
                            {p.id === currentPortfolioId ? (
                              <span className="font-semibold text-primary">
                                {p.name}
                              </span>
                            ) : (
                              p.name
                            )}
                          </button>
                        </TableCell>
                        {/* 成立日 = 首笔存入日（FIN-D6）：无存入记录时显示「未成立」，不冒充创建日 */}
                        <TableCell className="text-sm">
                          {p.baseDate ? (
                            formatDate(p.baseDate)
                          ) : (
                            <span
                              className="text-muted-foreground"
                              title="成立日 = 首笔存入日（FIN-D6）；该组合尚无存入记录"
                            >
                              未成立
                              <br />
                              <span className="text-[11px]">
                                创建于 {formatDate(p.createdAt)}
                              </span>
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{p.currency}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          ¥{formatCurrency(p.totalAsset || '0')}
                        </TableCell>
                        {/* 净值：累计净值，6 位小数字符串；null = 尚无 DailyNav */}
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {p.cumulativeNav != null
                            ? formatDecimal(p.cumulativeNav)
                            : NO_DATA}
                        </TableCell>
                        {/* 当年%：后端给比率（0.0523 = 5.23%），formatPercent 内部 ×100；正负着色按比率符号 */}
                        <TableCell
                          className={
                            p.yearReturnRate != null
                              ? Number(p.yearReturnRate) >= 0
                                ? 'text-right tabular-nums text-up'
                                : 'text-right tabular-nums text-down'
                              : 'text-right tabular-nums text-muted-foreground'
                          }
                        >
                          {p.yearReturnRate != null
                            ? formatPercent(p.yearReturnRate)
                            : NO_DATA}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {p.lastUpdatedAt
                            ? formatDate(p.lastUpdatedAt)
                            : NO_DATA}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="mt-3 text-xs text-muted-foreground">
                  ⓘ 点击组合名称可切换当前组合并跳转概览
                </p>
              </>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                暂无组合，点击右上角「新建组合」开始
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 新建组合对话框（复用设置页同款组件） */}
      <PortfolioDialog
        open={creating}
        onOpenChange={(o) => {
          if (!o) setCreating(false);
        }}
        portfolio={null}
      />
    </div>
  );
}
