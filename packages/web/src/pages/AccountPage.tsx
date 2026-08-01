/**
 * pages/AccountPage.tsx — 账户中心页
 *
 * 功能：
 * - 用户信息卡片：头像、昵称、邮箱、手机（脱敏）、简介、注册时间
 * - 头像支持本地上传和 URL 两种方式
 * - 账户统计：组合数、交易总数、记录天数
 * - 安全与操作区：修改邮箱、修改密码、编辑资料、退出登录
 *
 * 数据来源：
 * - GET /api/auth/profile — 用户信息
 * - GET /api/account/stats — 账户统计
 * - GET /api/portfolios/summary — 资产全景
 */

import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Mail,
  Phone,
  Calendar,
  Edit3,
  Key,
  LogOut,
  Upload,
  Link,
  FolderOpen,
  Hash,
  Clock,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingSpinner, CardSkeleton } from '@/components/LoadingSpinner';
import { PageHeader } from '@/components/PageHeader';
import { UserAvatar } from '@/components/user-avatar';
import { useAuthStore } from '@/stores/auth.store';
import { useProfile } from '@/hooks/use-auth';
import {
  useUpdatePassword,
  useUpdateEmail,
  useUpdateProfile,
  useUploadAvatar,
} from '@/hooks/use-account';
import { useQuery } from '@tanstack/react-query';
import { getAccountStats } from '@/api/account.api';
import { getPortfoliosSummary } from '@/api/overview.api';
import { ChangePasswordDialog } from '@/features/account/change-password-dialog';
import { ChangeEmailDialog } from '@/features/account/change-email-dialog';
import { EditProfileDialog } from '@/features/account/edit-profile-dialog';
import { formatCurrency, formatDate, formatPercent } from '@/lib/utils';
import { ROUTE_PATH } from '@/lib/constants';

/** 手机号脱敏 */
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '-';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export default function AccountPage(): JSX.Element {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
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

  // Dialog 状态
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // 头像 URL 设置
  const [avatarUrlOpen, setAvatarUrlOpen] = useState(false);
  const [avatarUrlInput, setAvatarUrlInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadAvatarMutation = useUploadAvatar();
  const updateProfileMutation = useUpdateProfile();

  const currentUser = user ?? profile.data;
  const isLoading = !currentUser && profile.isLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="账户中心" />
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

  function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) uploadAvatarMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleAvatarUrl(): void {
    if (!avatarUrlInput.trim()) return;
    updateProfileMutation.mutate(
      { avatar: avatarUrlInput.trim() },
      {
        onSuccess: () => {
          setAvatarUrlOpen(false);
          setAvatarUrlInput('');
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="账户中心"
        description="管理您的账户信息与安全设置"
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ===== 用户信息卡 ===== */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">个人信息</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {/* 头像 */}
            <div className="relative">
              <UserAvatar
                src={currentUser.avatar}
                name={currentUser.name}
                email={currentUser.email}
                size="lg"
              />

              {/* 头像设置入口 */}
              <div className="mt-3 flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadAvatarMutation.isPending}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  上传
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAvatarUrlOpen(true)}
                >
                  <Link className="mr-1 h-3.5 w-3.5" />
                  URL
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
              </div>
            </div>

            {/* 基本信息 */}
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
                注册于 {(currentUser as { createdAt?: string }).createdAt ? formatDate((currentUser as { createdAt?: string }).createdAt!) : '-'}
              </div>
              {currentUser.bio && (
                <p className="text-sm text-muted-foreground">
                  {currentUser.bio}
                </p>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="flex w-full flex-col gap-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => setProfileOpen(true)}
              >
                <Edit3 className="mr-2 h-4 w-4" />
                编辑资料
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => setEmailOpen(true)}
              >
                <Mail className="mr-2 h-4 w-4" />
                修改邮箱
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => setPasswordOpen(true)}
              >
                <Key className="mr-2 h-4 w-4" />
                修改密码
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start text-destructive hover:text-destructive"
                onClick={() => {
                  logout();
                  navigate(ROUTE_PATH.LOGIN);
                }}
              >
                <LogOut className="mr-2 h-4 w-4" />
                退出登录
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ===== 右侧区域 ===== */}
        <div className="space-y-6 lg:col-span-2">
          {/* 资产全景卡 */}
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
                  {/* 组合列表 */}
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
                                  ? 'text-red-600'
                                  : 'text-emerald-600'
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

          {/* 数据统计卡 */}
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

      {/* ===== 头像 URL 设置弹窗 ===== */}
      <Dialog open={avatarUrlOpen} onOpenChange={setAvatarUrlOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>设置头像 URL</DialogTitle>
            <DialogDescription>
              输入图片 URL 地址即可用作头像
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>头像 URL</Label>
              <Input
                placeholder="https://example.com/avatar.jpg"
                value={avatarUrlInput}
                onChange={(e) => setAvatarUrlInput(e.target.value)}
              />
            </div>
            {avatarUrlInput && (
              <div className="flex justify-center">
                <UserAvatar
                  src={avatarUrlInput}
                  name={currentUser.name}
                  email={currentUser.email}
                  size="lg"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAvatarUrlOpen(false);
                setAvatarUrlInput('');
              }}
            >
              取消
            </Button>
            <Button
              onClick={handleAvatarUrl}
              disabled={!avatarUrlInput.trim() || updateProfileMutation.isPending}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== 修改密码 ===== */}
      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />

      {/* ===== 修改邮箱 ===== */}
      <ChangeEmailDialog open={emailOpen} onOpenChange={setEmailOpen} />

      {/* ===== 编辑资料 ===== */}
      <EditProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </div>
  );
}
