/**
 * pages/AccountPage.tsx — 账户页（PRD：账户页 = 看，只读）
 *
 * 只读展示：
 * - 个人信息：头像 / 昵称 / 邮箱 / 手机（脱敏）/ 简介 / 注册时间
 * - 资产全景：全部组合摘要
 * - 数据统计：组合数 / 交易笔数 / 快照天数 / 记录天数 / 起止日期
 *
 * **不包含** 修改入口、退出登录、注销账户 —— 这些都在设置页（全站唯一修改入口）。
 *
 * 数据来源：
 * - GET /api/auth/profile — 用户信息
 * - GET /api/account/stats — 账户统计
 * - GET /api/portfolios/summary — 资产全景
 */

import { useQuery } from '@tanstack/react-query';
import {
  Calendar,
  Clock,
  FolderOpen,
  Hash,
  Mail,
  Phone,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardSkeleton } from '@/components/LoadingSpinner';
import { PageHeader } from '@/components/PageHeader';
import { UserAvatar } from '@/components/user-avatar';
import { useAuthStore } from '@/stores/auth.store';
import { useProfile } from '@/hooks/use-auth';
import { getAccountStats } from '@/api/account.api';
import { getPortfoliosSummary } from '@/api/overview.api';
import { formatCurrency, formatDate, formatPercent } from '@/lib/utils';

/** 手机号脱敏 */
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '-';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export default function AccountPage(): JSX.Element {
  const { user } = useAuthStore();
  const profile = useProfile();
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

  const currentUser = user ?? profile.data;
  const isLoading = !currentUser && profile.isLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="账户" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
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
        description="查看个人信息、资产全景与数据统计（修改入口见设置页）"
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ===== 个人信息（只读） ===== */}
        <Card className="lg:col-span-1">
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
                注册于{' '}
                {currentUser.createdAt
                  ? formatDate(currentUser.createdAt)
                  : '-'}
              </div>
              {currentUser.bio && (
                <p className="text-sm text-muted-foreground">{currentUser.bio}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ===== 右侧区域 ===== */}
        <div className="space-y-6 lg:col-span-2">
          {/* 资产全景（只读） */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">资产全景</CardTitle>
            </CardHeader>
            <CardContent>
              {summary.isLoading ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                      <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                      <div className="h-6 w-24 animate-pulse rounded bg-muted" />
                    </div>
                  ))}
                </div>
              ) : summary.data && summary.data.length > 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    <div>
                      <p className="text-xs text-muted-foreground">组合数</p>
                      <p className="text-xl font-bold tabular-nums">
                        {summary.data.length}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">合计总资产</p>
                      <p className="text-xl font-bold tabular-nums">
                        ¥
                        {formatCurrency(
                          summary.data.reduce(
                            (sum, p) => sum + parseFloat(p.totalAsset || '0'),
                            0,
                          ),
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">净值组合</p>
                      <p className="text-xl font-bold tabular-nums">
                        {
                          summary.data.filter((p) => p.cumulativeNav !== null)
                            .length
                        }
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 space-y-2">
                    {summary.data.slice(0, 5).map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
                      >
                        <div className="flex items-center gap-3">
                          <Wallet className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{p.name}</span>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="tabular-nums">
                            ¥{formatCurrency(p.totalAsset || '0')}
                          </span>
                          {p.cumulativeReturnRate !== null && (
                            <span
                              className={
                                p.cumulativeReturnRate >= 0
                                  ? 'text-up'
                                  : 'text-down'
                              }
                            >
                              {formatPercent(p.cumulativeReturnRate)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  暂无组合数据
                </p>
              )}
            </CardContent>
          </Card>

          {/* 数据统计（只读） */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">数据统计</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.isLoading ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                      <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                      <div className="h-6 w-24 animate-pulse rounded bg-muted" />
                    </div>
                  ))}
                </div>
              ) : stats.data ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                    <Hash className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">交易笔数</p>
                      <p className="text-lg font-bold tabular-nums">
                        {stats.data.transactionCount}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                    <FolderOpen className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">快照天数</p>
                      <p className="text-lg font-bold tabular-nums">
                        {stats.data.snapshotDays}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                    <Clock className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">记录天数</p>
                      <p className="text-lg font-bold tabular-nums">
                        {stats.data.recordDays}
                      </p>
                    </div>
                  </div>
                  {stats.data.firstDate && (
                    <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                      <Calendar className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">起始日期</p>
                        <p className="text-sm font-medium">
                          {formatDate(stats.data.firstDate)}
                        </p>
                      </div>
                    </div>
                  )}
                  {stats.data.lastDate && (
                    <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                      <Calendar className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">最近日期</p>
                        <p className="text-sm font-medium">
                          {formatDate(stats.data.lastDate)}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  暂无统计数据
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
