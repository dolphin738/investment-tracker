/**
 * pages/settings.tsx — 设置页
 *
 * 包含：
 * - 账户：用户信息摘要 + 操作入口
 * - 组合管理：列表 + 新建 + 编辑 + 删除
 * - 偏好设置：服务端持久化（usePreferences + 乐观更新）
 * - 数据管理：占位（v1 暂未开放）
 * - 关于
 *
 * 🆕 T05：偏好设置全面升级
 *       - 货币/语言/主题/数据刷新间隔等
 *       - usePreferences hook + preference.store
 *       - 乐观更新
 *       - shadcn/ui Select/RadioGroup/Switch 组件
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Lock,
  LogOut,
  Mail,
  Pencil,
  Plus,
  Trash2,
  Loader2,
  Palette,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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
import { Skeleton } from '@/components/ui/skeleton';
import { PortfolioDialog } from '@/features/portfolio/portfolio-dialog';
import { ChangeEmailDialog } from '@/features/account/change-email-dialog';
import { ChangePasswordDialog } from '@/features/account/change-password-dialog';
import { EditProfileDialog } from '@/features/account/edit-profile-dialog';
import { UserAvatar } from '@/components/user-avatar';
import { useAuthStore } from '@/stores/auth.store';
import {
  useDeletePortfolio,
  usePortfolios,
} from '@/hooks/use-portfolios';
import { usePortfolioStore } from '@/stores/portfolio.store';
import {
  usePreferences,
  useUpdatePreferences,
} from '@/hooks/use-preferences';
import { usePreferenceStore, DEFAULT_PREFERENCES } from '@/stores/preference.store';
import { ROUTE_PATH, AGGREGATION_OPTIONS, GRANULARITY_OPTIONS } from '@/lib/constants';
import type { Portfolio, UpdatePreferenceDto } from '@investment-tracker/shared';
import { formatDate } from '@/lib/utils';

/** 日期范围选项 */
const DATE_RANGE_OPTIONS = [
  { value: '3m', label: '近 3 月' },
  { value: '1y', label: '近 1 年' },
  { value: 'ytd', label: '今年至今' },
  { value: 'all', label: '全部' },
] as const;

/** 主题选项 */
const THEME_OPTIONS = [
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
  { value: 'system', label: '跟随系统' },
] as const;

/** 小数位选项 */
const DECIMAL_OPTIONS = [2, 3, 4, 5, 6].map((n) => ({
  value: String(n),
  label: `${n} 位`,
}));

/** XIRR 小数位选项 */
const XIRR_DECIMAL_OPTIONS = [2, 3, 4].map((n) => ({
  value: String(n),
  label: `${n} 位`,
}));

export default function SettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();
  const deleteMutation = useDeletePortfolio();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const setCurrentPortfolio = usePortfolioStore((s) => s.setCurrentPortfolio);

  // 偏好 hooks
  const { data: serverPrefs, isLoading: prefsLoading } = usePreferences();
  const updatePrefsMutation = useUpdatePreferences();
  const prefStore = usePreferenceStore();

  // 同步服务端偏好到本地 store
  useEffect(() => {
    if (serverPrefs) {
      prefStore.setPreferences(serverPrefs);
    }
  }, [serverPrefs, prefStore]);

  const [editing, setEditing] = useState<Portfolio | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 账户修改对话框显隐
  const [emailDialogOpen, setEmailDialogOpen] = useState<boolean>(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState<boolean>(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState<boolean>(false);

  // 🆕 偏好本地编辑状态（乐观更新）
  const [prefForm, setPrefForm] = useState({
    defaultPortfolioId: '',
    defaultGranularity: DEFAULT_PREFERENCES.defaultGranularity,
    defaultDateRange: DEFAULT_PREFERENCES.defaultDateRange,
    aggregation: DEFAULT_PREFERENCES.aggregation,
    weekStartsOn: DEFAULT_PREFERENCES.weekStartsOn,
    navDecimals: DEFAULT_PREFERENCES.navDecimals,
    xirrDecimals: DEFAULT_PREFERENCES.xirrDecimals,
    theme: DEFAULT_PREFERENCES.theme,
    staleDays: DEFAULT_PREFERENCES.staleDays,
  });

  // 当服务端偏好加载完成后同步表单
  useEffect(() => {
    if (serverPrefs) {
      setPrefForm({
        defaultPortfolioId: serverPrefs.defaultPortfolioId ?? '',
        defaultGranularity: serverPrefs.defaultGranularity,
        defaultDateRange: serverPrefs.defaultDateRange,
        aggregation: serverPrefs.aggregation,
        weekStartsOn: serverPrefs.weekStartsOn,
        navDecimals: serverPrefs.navDecimals,
        xirrDecimals: serverPrefs.xirrDecimals,
        theme: serverPrefs.theme,
        staleDays: serverPrefs.staleDays,
      });
    }
  }, [serverPrefs]);

  const handleLogout = () => {
    logout();
    navigate(ROUTE_PATH.LOGIN);
  };

  const handleConfirmDelete = () => {
    if (deletingId) {
      deleteMutation.mutate(deletingId, {
        onSettled: () => setDeletingId(null),
      });
    }
  };

  /** 🆕 保存偏好（乐观更新） */
  const handleSavePreferences = () => {
    const payload: UpdatePreferenceDto = { ...prefForm };
    // 空字符串视为 null
    if (payload.defaultPortfolioId === '') {
      payload.defaultPortfolioId = null;
    }
    updatePrefsMutation.mutate(payload);
  };

  /** 🆕 更新表单单个字段 */
  const updateField = <K extends keyof typeof prefForm>(
    key: K,
    value: (typeof prefForm)[K],
  ) => {
    setPrefForm((prev) => ({ ...prev, [key]: value }));
  };

  /** 手机号脱敏展示 */
  const maskedPhone = user?.phone
    ? `${user.phone.slice(0, 3)}****${user.phone.slice(7)}`
    : '-';

  /** 偏好是否有变更 */
  const hasPrefChanges =
    serverPrefs &&
    (prefForm.defaultPortfolioId !== (serverPrefs.defaultPortfolioId ?? '') ||
      prefForm.defaultGranularity !== serverPrefs.defaultGranularity ||
      prefForm.defaultDateRange !== serverPrefs.defaultDateRange ||
      prefForm.aggregation !== serverPrefs.aggregation ||
      prefForm.weekStartsOn !== serverPrefs.weekStartsOn ||
      prefForm.navDecimals !== serverPrefs.navDecimals ||
      prefForm.xirrDecimals !== serverPrefs.xirrDecimals ||
      prefForm.theme !== serverPrefs.theme ||
      prefForm.staleDays !== serverPrefs.staleDays);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="text-sm text-muted-foreground">
          管理账户、组合与偏好设置
        </p>
      </div>

      {/* 账户 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">账户</CardTitle>
          <CardDescription>当前登录用户信息与安全设置</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 头像 + 昵称 + 邮箱 */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <UserAvatar
              size="lg"
              src={user?.avatar}
              name={user?.name}
              email={user?.email ?? ''}
            />
            <div className="min-w-0">
              <p className="truncate text-base font-medium">
                {user?.name || '未设置'}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {user?.email ?? '-'}
              </p>
            </div>
          </div>

          {/* 资料明细 */}
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">手机号</Label>
              <p className="mt-1 font-mono">{maskedPhone}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">个人简介</Label>
              <p className="mt-1 whitespace-pre-wrap break-words">
                {user?.bio || '-'}
              </p>
            </div>
          </div>

          {/* 操作区 */}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEmailDialogOpen(true)}
            >
              <Mail className="mr-2 h-4 w-4" />
              修改邮箱
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPasswordDialogOpen(true)}
            >
              <Lock className="mr-2 h-4 w-4" />
              修改密码
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProfileDialogOpen(true)}
            >
              <Pencil className="mr-2 h-4 w-4" />
              编辑资料
            </Button>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              退出登录
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 组合管理 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">组合管理</CardTitle>
            <CardDescription>创建、编辑或删除投资组合</CardDescription>
          </div>
          <Button onClick={() => setCreating(true)} size="sm">
            <Plus className="mr-2 h-4 w-4" />
            新建组合
          </Button>
        </CardHeader>
        <CardContent>
          {portfoliosLoading ? (
            <div className="text-sm text-muted-foreground">加载中…</div>
          ) : portfolios.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无组合，请点击右上角新建
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>描述</TableHead>
                  <TableHead>成立日</TableHead>
                  <TableHead>币种</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {portfolios.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      {p.id === currentPortfolioId ? (
                        <span className="font-semibold text-primary">{p.name}</span>
                      ) : (
                        <button
                          className="text-left hover:underline"
                          onClick={() => setCurrentPortfolio(p.id)}
                        >
                          {p.name}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.description || '-'}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {p.baseDate ? formatDate(p.baseDate) : '-'}
                    </TableCell>
                    <TableCell className="text-sm">{p.currency}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditing(p)}
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeletingId(p.id)}
                          title="删除"
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 🆕 偏好设置（全面升级） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">偏好设置</CardTitle>
          <CardDescription>
            偏好跟随账号存储，换设备登录仍生效
          </CardDescription>
        </CardHeader>
        <CardContent>
          {prefsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              {/* 默认组合 */}
              <div className="space-y-2">
                <Label htmlFor="pref-portfolio">默认组合</Label>
                <Select
                  value={prefForm.defaultPortfolioId || '__none__'}
                  onValueChange={(v) =>
                    updateField('defaultPortfolioId', v === '__none__' ? '' : v)
                  }
                >
                  <SelectTrigger id="pref-portfolio" className="w-[260px]">
                    <SelectValue placeholder="选择默认组合" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不设置</SelectItem>
                    {portfolios.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  登录后自动选中该组合
                </p>
              </div>

              {/* 默认时间维度 + 日期范围（并排） */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="pref-granularity">默认时间维度</Label>
                  <Select
                    value={prefForm.defaultGranularity}
                    onValueChange={(v) => updateField('defaultGranularity', v)}
                  >
                    <SelectTrigger id="pref-granularity" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GRANULARITY_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pref-daterange">默认日期范围</Label>
                  <Select
                    value={prefForm.defaultDateRange}
                    onValueChange={(v) => updateField('defaultDateRange', v)}
                  >
                    <SelectTrigger id="pref-daterange" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DATE_RANGE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* 聚合方式 + 周起始日（并排） */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="pref-aggregation">周期聚合方式</Label>
                  <Select
                    value={prefForm.aggregation}
                    onValueChange={(v) => updateField('aggregation', v)}
                  >
                    <SelectTrigger id="pref-aggregation" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGGREGATION_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>周起始日</Label>
                  <RadioGroup
                    value={String(prefForm.weekStartsOn)}
                    onValueChange={(v) => updateField('weekStartsOn', Number(v))}
                    orientation="horizontal"
                  >
                    <RadioGroupItem value="1" label="周一" />
                    <RadioGroupItem value="0" label="周日" />
                  </RadioGroup>
                </div>
              </div>

              {/* 小数位设置（并排） */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="pref-navdec">净值小数位</Label>
                  <Select
                    value={String(prefForm.navDecimals)}
                    onValueChange={(v) => updateField('navDecimals', Number(v))}
                  >
                    <SelectTrigger id="pref-navdec" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DECIMAL_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pref-xirrdec">XIRR 小数位</Label>
                  <Select
                    value={String(prefForm.xirrDecimals)}
                    onValueChange={(v) => updateField('xirrDecimals', Number(v))}
                  >
                    <SelectTrigger id="pref-xirrdec" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {XIRR_DECIMAL_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* 外观主题 */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <Palette className="h-4 w-4" />
                  外观主题
                </Label>
                <RadioGroup
                  value={prefForm.theme}
                  onValueChange={(v) => updateField('theme', v)}
                  orientation="horizontal"
                >
                  {THEME_OPTIONS.map((opt) => (
                    <RadioGroupItem key={opt.value} value={opt.value} label={opt.label} />
                  ))}
                </RadioGroup>
                <p className="text-xs text-muted-foreground">
                  选择「跟随系统」将根据操作系统设置自动切换
                </p>
              </div>

              {/* 快照过期阈值 */}
              <div className="space-y-2">
                <Label htmlFor="pref-stale">快照过期提醒阈值（天）</Label>
                <Input
                  id="pref-stale"
                  type="number"
                  min={1}
                  max={30}
                  className="w-[120px]"
                  value={prefForm.staleDays}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 1 && v <= 30) updateField('staleDays', v);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  资产快照超过此天数未更新时显示提醒（1~30 天）
                </p>
              </div>

              {/* 🆕 货币 / 语言（待后端集成） */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="pref-currency">货币</Label>
                  <Select defaultValue="CNY" disabled>
                    <SelectTrigger id="pref-currency" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CNY">人民币 (CNY)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    待后端集成（当前仅支持 CNY）
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pref-lang">语言</Label>
                  <Select defaultValue="zh-CN" disabled>
                    <SelectTrigger id="pref-lang" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zh-CN">中文（简体）</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    待后端集成（当前仅支持中文）
                  </p>
                </div>
              </div>

              {/* 保存按钮 */}
              <div className="flex items-center gap-3 pt-2">
                <Button
                  onClick={handleSavePreferences}
                  disabled={!hasPrefChanges || updatePrefsMutation.isPending}
                >
                  {updatePrefsMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  保存偏好
                </Button>
                {!hasPrefChanges && serverPrefs && (
                  <span className="text-xs text-muted-foreground">已是最新</span>
                )}
                {updatePrefsMutation.isError && (
                  <span className="text-xs text-red-500">保存失败，请重试</span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 数据管理 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">数据管理</CardTitle>
          <CardDescription>导入导出（v1 暂未开放，列入 P1）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" disabled>
            导入数据 (CSV/Excel)
          </Button>
          <Button variant="outline" disabled className="ml-2">
            导出数据
          </Button>
          <Button variant="outline" disabled className="ml-2">
            下载导入模板
          </Button>
        </CardContent>
      </Card>

      {/* 关于 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">关于</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <div>版本 v1.1.0</div>
          <div>基于 XIRR 算法的投资收益统计系统</div>
        </CardContent>
      </Card>

      {/* 账户修改对话框 */}
      <ChangeEmailDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
      />
      <ChangePasswordDialog
        open={passwordDialogOpen}
        onOpenChange={setPasswordDialogOpen}
      />
      <EditProfileDialog
        open={profileDialogOpen}
        onOpenChange={setProfileDialogOpen}
      />

      {/* 创建/编辑组合对话框 */}
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

      {/* 删除组合确认 */}
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
