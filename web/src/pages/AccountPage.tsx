/**
 * pages/AccountPage.tsx — 账户中心（PRD v3.1.8 §7.7 · 组合管理平面收敛后的新契约）
 *
 * 【只读契约（已调整）】账户页整体仍是只读聚合视图，**唯一例外是「我的组合」卡**：
 * 该卡是全站唯一的组合管理平面，承接组合 CRUD（新建 / 编辑 / 归档 / 删除 / 设为默认）。
 * 其余三张卡（个人信息 / 资产全景 / 数据统计）保持零修改控件，不得新增任何写入入口。
 *
 * 四张卡（草图逐项对齐）：
 * - 👤 个人信息（ACC-P0-02，**只读**）：头像 / 昵称 / 邮箱 / 手机（脱敏）/ 简介 / 注册时间；
 *      资料与安全修改仍在设置页，卡内只保留「前往设置修改 →」跳转链接
 * - 📊 资产全景（ACC-P0-03，**只读**）：组合数 / 合计总资产 / 合计净投入 / 合计浮动盈亏
 * - 📈 数据统计（ACC-P0-06，**只读**）：出入金笔数 / 证券买卖笔数 / 总资产记录天数 / 数据区间 / 账户使用天数
 * - 💼 我的组合（ACC-P0-04，**唯一可写块**）：统一表格 = 业绩列 + 管理操作列；
 *      点击组合名 = 切换当前组合并跳转概览；右上 [+新建组合]；行尾 设为默认 / 编辑 / 归档 / 删除
 *
 * 数据来源（「我的组合」按 id 前端合并两个数据源）：
 * - GET /api/auth/profile        — 用户信息（优先于 auth store，避免旧 localStorage 缓存缺 createdAt）
 * - GET /api/account/stats       — 账户统计（cashflowCount / tradeCount）
 * - GET /api/portfolios/summary  — 资产全景（跨组合）+ 组合业绩列（成立日 / 币种 / 净值 / 当年% / 净投入 / 浮动盈亏）
 * - GET /api/portfolios          — 组合元信息（description / archivedAt），经 usePortfolios() 读缓存
 *
 * 【为什么能安全按 id 合并】后端 `PortfolioService.list_for_user` 与
 * `AggregationService.summary_list` 都是 `select(Portfolio).where(user_id==…).order_by(created_at.desc())`，
 * 同一集合、同一排序、都不过滤归档；且 usePortfolios() 已被布局层组合选择器调用（staleTime 60s），
 * 本页复用缓存不产生额外请求。极端情况下某 id 在元信息里缺失时，管理列降级为
 * 「描述显示 -、不显示归档标记、按钮仍可点」，绝不抛错。
 *
 * 金融口径约定：金额/净值/收益率以 string 跨网；「无数据」为 null，渲染「—」或「未成立」，
 * 禁止把 null 渲染成 0（SYS-P0-05 四态）。跨组合仅做金额类求和（Q-07：不做合计 XIRR / 合计净值）。
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowRightLeft,
  Calendar,
  CalendarRange,
  Clock,
  LineChart,
  Loader2,
  Mail,
  Pencil,
  Phone,
  Plus,
  Star,
  Trash2,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CardSkeleton } from '@/components/LoadingSpinner';
import { PageHeader } from '@/components/PageHeader';
import { UserAvatar } from '@/components/user-avatar';
import { PortfolioDialog } from '@/features/portfolio/portfolio-dialog';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { useAuthStore } from '@/stores/auth.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { useProfile } from '@/hooks/use-auth';
import { usePreferences } from '@/hooks/use-preferences';
import {
  useArchivePortfolio,
  useDeletePortfolio,
  usePortfolios,
  useSetDefaultPortfolio,
} from '@/hooks/use-portfolios';
import { getAccountStats } from '@/api/account.api';
import { getPortfoliosSummary } from '@/api/overview.api';
import { ROUTE_PATH } from '@/lib/constants';
import { cn, formatCurrency, formatDate, formatDecimal, formatPercent } from '@/lib/utils';
import type { PortfolioSummary } from '@/api/types';
import type { Portfolio } from '@/lib/types';

/** 无数据统一占位符（SYS-P0-05 四态：缺数据不白屏、不伪造；null 是「无数据」不是 0） */
const NO_DATA = '—';

/** 手机号脱敏 */
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '-';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/**
 * 「我的组合」统一表格的一行：业绩列来自 summary，管理列来自组合元信息。
 *
 * `hasMeta = false` 表示该组合在 `usePortfolios()` 结果里缺失（理论上不会发生，
 * 两个后端查询同集合同排序），此时 `meta` 是由 summary 现场合成的降级对象，
 * 保证操作列仍可点击、不抛错。
 */
interface PortfolioRow {
  /** 业绩字段（GET /portfolios/summary） */
  summary: PortfolioSummary;
  /** 管理字段（GET /portfolios，或缺失时的降级合成对象） */
  meta: Portfolio;
  /** 元信息是否真实命中 */
  hasMeta: boolean;
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
  const getPreference = usePreferenceStore((s) => s.getPreference);
  const navDecimals = getPreference('navDecimals');
  const xirrDecimals = getPreference('xirrDecimals');
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');

  /** 组合管理弹窗状态（[+新建组合] / 编辑 / 删除二次确认） */
  const [creating, setCreating] = useState<boolean>(false);
  const [editing, setEditing] = useState<Portfolio | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── 组合管理数据与 mutation ──
  const { data: portfolios = [] } = usePortfolios();
  const { data: serverPrefs } = usePreferences();
  const deleteMutation = useDeletePortfolio();
  const archiveMutation = useArchivePortfolio();
  const setDefaultMutation = useSetDefaultPortfolio();

  /**
   * 当前默认组合 ID（服务端偏好口径）
   *
   * 用本地 state 承接而非直接读 serverPrefs，是为了让「设为默认」点击后立即高亮星标
   * （mutation onSuccess 直接写入返回值），不必等偏好查询失效重取。
   */
  const [defaultPortfolioId, setDefaultPortfolioId] = useState<string>('');
  useEffect(() => {
    if (serverPrefs) {
      setDefaultPortfolioId(serverPrefs.defaultPortfolioId ?? '');
    }
  }, [serverPrefs]);

  const isDefaultPortfolio = (portfolioId: string): boolean =>
    defaultPortfolioId === portfolioId;

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

  /** 组合元信息索引：id → Portfolio（description / archivedAt 的来源） */
  const portfolioMetaMap = useMemo(() => {
    const map = new Map<string, Portfolio>();
    for (const p of portfolios) {
      map.set(p.id, p);
    }
    return map;
  }, [portfolios]);

  /**
   * 统一表格行：以 summary 为遍历主序（后端已按 createdAt desc 排好），
   * 逐行补挂管理字段；缺失时合成降级对象（描述空、未归档），保证操作列不崩。
   */
  const portfolioRows = useMemo<PortfolioRow[]>(() => {
    if (!summary.data) return [];
    return summary.data.map((s) => {
      const meta = portfolioMetaMap.get(s.id);
      if (meta) {
        return { summary: s, meta, hasMeta: true };
      }
      const fallback: Portfolio = {
        id: s.id,
        userId: '',
        name: s.name,
        description: null,
        baseDate: s.baseDate,
        currency: s.currency,
        archivedAt: null,
        createdAt: s.createdAt,
        updatedAt: s.createdAt,
      };
      return { summary: s, meta: fallback, hasMeta: false };
    });
  }, [summary.data, portfolioMetaMap]);

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

  /**
   * 「设为默认 / 取消默认」（项6 · SET-P0-06 · 自设置页组合管理原样迁移）
   *
   * toggle 语义：调用 PATCH /portfolios/:id/default，后端已是默认则取消、否则设为默认。
   * 成功后把本地 defaultPortfolioId 对齐返回值，星标立即同步；
   * 已归档组合不能作为默认组合（按钮同时 disabled，此处再做一次防御）。
   */
  const handleSetDefaultPortfolio = (portfolio: Portfolio): void => {
    if (portfolio.archivedAt) {
      return;
    }
    setDefaultMutation.mutate(portfolio.id, {
      onSuccess: (pref) => {
        setDefaultPortfolioId(pref.defaultPortfolioId ?? '');
      },
    });
  };

  /** 删除二次确认后的实际删除 */
  const handleConfirmDelete = (): void => {
    if (deletingId) {
      deleteMutation.mutate(deletingId, {
        onSettled: () => setDeletingId(null),
      });
    }
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
        description="账户中心 · 组合管理在「我的组合」卡完成；其余分区为只读聚合视图（资料与安全修改见设置页）"
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
            {/* 卡内无任何修改控件（§7.7 L1320-1322）：资料/安全修改仍在设置页，仅提供跳转 */}
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

        {/* ===== 资产全景（只读 · ACC-P0-03） ===== */}
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
                      {formatCurrency(totalAsset, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">合计净投入</p>
                    <p className="text-xl font-bold tabular-nums">
                      {formatCurrency(totalNetInvested, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">合计浮动盈亏</p>
                    <p className="text-xl font-bold tabular-nums">
                      {totalFloatingProfit != null
                        ? formatCurrency(totalFloatingProfit, 2, { thousands: amountThousands, abbreviate: amountAbbrev })
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

        {/* ===== 数据统计（只读 · ACC-P0-06） ===== */}
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

        {/* =====================================================================
            我的组合（ACC-P0-04 · 全站唯一组合管理平面）
            统一表格 = 业绩列（summary）+ 管理列（组合元信息），独占整行不可挤 1/3 宽
           ===================================================================== */}
        <Card className="xl:col-span-12">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">我的组合</CardTitle>
            {/* INC-05：与全站录入入口同规格（主色 sm + Plus），文案取自统一字典 */}
            <Button
              size={ENTRY_BUTTON_SIZE}
              variant={ENTRY_BUTTON_VARIANT}
              onClick={() => setCreating(true)}
            >
              <Plus className={ENTRY_BUTTON_ICON_CLASS} />
              {ENTRY_BUTTON_LABELS.portfolio}
            </Button>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-9 animate-pulse rounded bg-muted" />
                ))}
              </div>
            ) : portfolioRows.length > 0 ? (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>组合名称</TableHead>
                      <TableHead>描述</TableHead>
                      <TableHead>成立日</TableHead>
                      <TableHead>币种</TableHead>
                      <TableHead className="text-right">最新总资产</TableHead>
                      <TableHead className="text-right">净值</TableHead>
                      <TableHead className="text-right">当年%</TableHead>
                      <TableHead>更新日</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {portfolioRows.map(({ summary: p, meta }) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">
                          <span className="inline-flex items-center gap-2">
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
                            {meta.archivedAt && (
                              <span className="text-xs text-muted-foreground">
                                已归档
                              </span>
                            )}
                          </span>
                        </TableCell>
                        {/* 描述：来自组合元信息；缺失时降级为 '-' */}
                        <TableCell className="text-sm text-muted-foreground">
                          {meta.description || '-'}
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
                          {formatCurrency(p.totalAsset || '0', 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                        </TableCell>
                        {/* 净值：累计净值，6 位小数字符串；null = 尚无 DailyNav */}
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {p.cumulativeNav != null
                            ? formatDecimal(p.cumulativeNav, navDecimals)
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
                            ? formatPercent(p.yearReturnRate, 2, { decimals: xirrDecimals })
                            : NO_DATA}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {p.lastUpdatedAt
                            ? formatDate(p.lastUpdatedAt)
                            : NO_DATA}
                        </TableCell>
                        {/* 管理操作列（自设置页组合管理原样迁移：文案 / title / disabled 逐项对齐） */}
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {/* 设为默认 / 取消默认（项6 · SET-P0-06）：toggle 切换 defaultPortfolioId */}
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleSetDefaultPortfolio(meta)}
                              title={
                                meta.archivedAt
                                  ? '已归档组合不能设为默认'
                                  : isDefaultPortfolio(p.id)
                                    ? '取消默认'
                                    : '设为默认'
                              }
                              aria-label={
                                isDefaultPortfolio(p.id) ? '取消默认' : '设为默认'
                              }
                              disabled={
                                Boolean(meta.archivedAt) || setDefaultMutation.isPending
                              }
                            >
                              <Star
                                className={cn(
                                  'h-4 w-4',
                                  isDefaultPortfolio(p.id)
                                    ? 'fill-primary text-primary'
                                    : '',
                                )}
                              />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditing(meta)}
                              title="编辑"
                              aria-label="编辑"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() =>
                                archiveMutation.mutate({
                                  id: p.id,
                                  archived: !meta.archivedAt,
                                })
                              }
                              title={meta.archivedAt ? '取消归档' : '归档'}
                              aria-label={meta.archivedAt ? '取消归档' : '归档'}
                              disabled={archiveMutation.isPending}
                            >
                              <Archive
                                className={cn(
                                  'h-4 w-4',
                                  meta.archivedAt ? 'text-primary' : '',
                                )}
                              />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setDeletingId(p.id)}
                              title="删除"
                              aria-label="删除"
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="mt-3 space-y-1 text-xs text-muted-foreground">
                  ⓘ 点击组合名称可切换当前组合并跳转概览；右侧操作列可设为默认 / 编辑 / 归档 / 删除
                  <br />
                  ⓘ ★ 设为默认：登录后自动选中该组合（写入偏好 defaultPortfolioId）；已归档组合不能设为默认
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

      {/* 新建 / 编辑组合对话框（同一组件双模式：portfolio 非空即编辑） */}
      <PortfolioDialog
        open={creating || Boolean(editing)}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        portfolio={editing}
      />

      {/* 删除组合确认（二次确认，文案自设置页原样迁移） */}
      <AlertDialog
        open={Boolean(deletingId)}
        onOpenChange={(o) => !o && setDeletingId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该组合？</AlertDialogTitle>
            <AlertDialogDescription>
              删除组合将级联删除其下所有交易、快照、净值与 XIRR 数据，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
