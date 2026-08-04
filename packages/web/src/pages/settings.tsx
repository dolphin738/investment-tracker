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
  Archive,
  Lock,
  LogOut,
  Mail,
  Pencil,
  Plus,
  Star,
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
import { useDeleteAccount } from '@/hooks/use-account';
import {
  useArchivePortfolio,
  useClearPortfolioData,
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
import type { Portfolio } from '@investment-tracker/shared';
import type { UpdatePreferenceDto } from '@/api/types';
import { cn, formatDate } from '@/lib/utils';

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

/**
 * 勾选项（原生 checkbox + Tailwind，风格对齐 components/ui/radio-group.tsx 的实现口径，
 * 不额外引入 @radix-ui/react-checkbox 依赖）。
 */
function PrefCheckbox({
  id,
  checked,
  onCheckedChange,
  label,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <label
      htmlFor={id}
      className="inline-flex cursor-pointer items-center gap-2 text-sm"
    >
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 rounded border-input accent-primary"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export default function SettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();
  const deleteMutation = useDeletePortfolio();
  const archiveMutation = useArchivePortfolio();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const setCurrentPortfolio = usePortfolioStore((s) => s.setCurrentPortfolio);

  // 偏好 hooks
  const { data: serverPrefs, isLoading: prefsLoading } = usePreferences();
  const updatePrefsMutation = useUpdatePreferences();
  // 只订阅 action，不订阅整个 store：
  // usePreferenceStore() 无选择器会订阅全量 state，setPreferences 每次都会产生新的
  // state 引用，导致下面的 effect 依赖恒变 → 无限更新循环 → 整页白屏。
  const setPreferences = usePreferenceStore((s) => s.setPreferences);

  // 同步服务端偏好到本地 store
  useEffect(() => {
    if (serverPrefs) {
      setPreferences(serverPrefs);
    }
  }, [serverPrefs, setPreferences]);

  const [editing, setEditing] = useState<Portfolio | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 账户修改对话框显隐
  const [emailDialogOpen, setEmailDialogOpen] = useState<boolean>(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState<boolean>(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState<boolean>(false);

  // 注销账户（危险操作 · SET-P1-06）
  const [deleteAccountOpen, setDeleteAccountOpen] = useState<boolean>(false);
  const [deleteAccountEmail, setDeleteAccountEmail] = useState<string>('');
  const deleteAccountMutation = useDeleteAccount();

  // 清空当前组合数据（危险操作 · SET-P0-05）
  const [clearDataOpen, setClearDataOpen] = useState<boolean>(false);
  const [clearDataConfirmName, setClearDataConfirmName] = useState<string>('');
  const clearDataMutation = useClearPortfolioData();
  const currentPortfolio = portfolios.find((p) => p.id === currentPortfolioId) ?? null;

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

  /**
   * ⚠️ 后端缺口 D · 仅本地渲染、**不进 PATCH payload** 的偏好项
   *
   * - 软提示开关（SET-P0-07）：`cashHintOnCashflow` / `cashHintOnTrade`
   * - 金额格式（SET-P1-03）：`amountThousands` / `amountAbbrev`
   *
   * 后端 `prisma/schema.prisma` 的 `UserPreference` 与 `UpdatePreferenceDto`
   * 均无这些列/字段，而 NestJS 侧开启了 `ValidationPipe({ forbidNonWhitelisted: true })`，
   * 一旦把它们塞进 PATCH /api/users/preferences 会直接 400。
   * 因此本轮只渲染控件、只做本地态，待后端补齐上述四个字段后再接入
   * `prefForm` + `handleSavePreferences` 的 payload。
   */
  const [uiOnlyPrefs, setUiOnlyPrefs] = useState({
    cashHintOnCashflow: DEFAULT_PREFERENCES.cashHintOnCashflow,
    cashHintOnTrade: DEFAULT_PREFERENCES.cashHintOnTrade,
    amountThousands: true,
    amountAbbrev: false,
  });

  /** 更新「仅渲染」偏好项（不落库，见 uiOnlyPrefs 注释） */
  const updateUiOnlyPref = <K extends keyof typeof uiOnlyPrefs>(
    key: K,
    value: (typeof uiOnlyPrefs)[K],
  ) => {
    setUiOnlyPrefs((prev) => ({ ...prev, [key]: value }));
  };

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
      // 后端暂不返回软提示字段（缺口 D），用 ?? 回落默认值，避免 undefined 造成非受控警告
      setUiOnlyPrefs((prev) => ({
        ...prev,
        cashHintOnCashflow:
          serverPrefs.cashHintOnCashflow ?? DEFAULT_PREFERENCES.cashHintOnCashflow,
        cashHintOnTrade:
          serverPrefs.cashHintOnTrade ?? DEFAULT_PREFERENCES.cashHintOnTrade,
      }));
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

  /**
   * 🆕 保存偏好（乐观更新）
   *
   * 「默认组合」是服务端偏好（preference.defaultPortfolioId），
   * 而界面当前显示哪个组合由 portfolio store 的 currentPortfolioId 决定，两者相互独立。
   * 此前只写偏好、不动 store，PreferenceBootstrap 又只在 currentPortfolioId 为空时才按
   * 默认组合选中，于是「改了默认组合必须重登才生效」。
   * 这里在保存成功后主动把当前组合切到新的默认组合，符合用户预期。
   */
  const handleSavePreferences = () => {
    const nextDefault =
      prefForm.defaultPortfolioId === '' ? null : prefForm.defaultPortfolioId;
    const payload: UpdatePreferenceDto = { ...prefForm };
    // 空字符串视为 null
    if (payload.defaultPortfolioId === '') {
      payload.defaultPortfolioId = null;
    }
    updatePrefsMutation.mutate(payload, {
      onSuccess: () => {
        // 选择「不设置」时不动当前视图，只有明确指定了新默认组合才切换
        if (nextDefault && nextDefault !== currentPortfolioId) {
          setCurrentPortfolio(nextDefault);
        }
      },
    });
  };

  /**
   * 当前默认组合 ID（服务端偏好口径）
   *
   * 取 prefForm 而非 serverPrefs，是为了让「设为默认」点击后立即高亮，
   * 与偏好区下拉框保持同一数据源，避免两处显示打架。
   */
  const isDefaultPortfolio = (portfolioId: string): boolean =>
    prefForm.defaultPortfolioId === portfolioId;

  /**
   * 🆕 组合管理区「设为默认」（SET-P0-06 · §7.8 ④ 操作列）
   *
   * 与 handleSavePreferences 的默认组合逻辑保持完全一致：
   * 先写服务端偏好 defaultPortfolioId，成功后把当前视图组合切过去，
   * 并同步偏好表单，避免「保存偏好」按钮误显示为有未保存变更。
   * 已归档组合不能作为默认组合（默认组合下拉同样过滤了 archivedAt）。
   */
  const handleSetDefaultPortfolio = (portfolio: Portfolio) => {
    if (portfolio.archivedAt) {
      return;
    }
    updatePrefsMutation.mutate(
      { defaultPortfolioId: portfolio.id },
      {
        onSuccess: () => {
          setPrefForm((prev) => ({ ...prev, defaultPortfolioId: portfolio.id }));
          if (portfolio.id !== currentPortfolioId) {
            setCurrentPortfolio(portfolio.id);
          }
        },
      },
    );
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
          {/* 头像 + 昵称 + 邮箱 + 账户中心入口（§7.8 L1315） */}
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
            <Button
              variant="link"
              size="sm"
              className="sm:ml-auto"
              onClick={() => navigate(ROUTE_PATH.ACCOUNT)}
            >
              前往账户中心 →
            </Button>
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

          {/* 头像修改提示（§7.8 L1318-1319）：本区只展示头像，不提供独立头像 URL 框 */}
          <p className="text-xs text-muted-foreground">
            ⓘ 头像修改在「编辑资料」卡片内完成（本地上传 与 头像 URL 并列）；本区只展示头像，不提供独立的「头像 URL」输入框
          </p>
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
                    {portfolios
                      .filter((p) => !p.archivedAt)
                      .map((p) => (
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

              {/*
                软提示开关（SET-P0-07 · §7.8 L1376）
                ⚠️ 后端缺口 D：UserPreference 表与 UpdatePreferenceDto 均无
                cashHintOnCashflow / cashHintOnTrade 列，提交会被 forbidNonWhitelisted 拒为 400，
                故此处只渲染控件、只改本地态，不进 handleSavePreferences 的 payload。
              */}
              <div className="space-y-2">
                <Label>软提示开关</Label>
                <div className="flex flex-wrap items-center gap-6">
                  <PrefCheckbox
                    id="pref-hint-cashflow"
                    checked={uiOnlyPrefs.cashHintOnCashflow}
                    onCheckedChange={(v) =>
                      updateUiOnlyPref('cashHintOnCashflow', v)
                    }
                    label="出入金后提示"
                  />
                  <PrefCheckbox
                    id="pref-hint-trade"
                    checked={uiOnlyPrefs.cashHintOnTrade}
                    onCheckedChange={(v) => updateUiOnlyPref('cashHintOnTrade', v)}
                    label="买卖后提示"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  录入后提示同步更新现金余额（SET-P0-07）；⚠️ 待后端补充字段后方可持久化
                </p>
              </div>

              {/*
                金额格式（SET-P1-03 · §7.8 L1377）
                ⚠️ 后端缺口 D：待后端新增 UserPreference.amountThousands / amountAbbrev
              */}
              <div className="space-y-2">
                <Label>金额格式</Label>
                <div className="flex flex-wrap items-center gap-6">
                  <PrefCheckbox
                    id="pref-amount-thousands"
                    checked={uiOnlyPrefs.amountThousands}
                    onCheckedChange={(v) => updateUiOnlyPref('amountThousands', v)}
                    label="千分位"
                  />
                  <PrefCheckbox
                    id="pref-amount-abbrev"
                    checked={uiOnlyPrefs.amountAbbrev}
                    onCheckedChange={(v) => updateUiOnlyPref('amountAbbrev', v)}
                    label="万 / 亿缩写"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  金额展示格式（SET-P1-03）；⚠️ 待后端补充字段后方可持久化
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

      {/*
        数据管理（§7.8 ③ · SET-P0-03 导出 / SET-P0-04 导入）
        本轮**仅视觉对齐草图**，导出/导入逻辑不实现：所有控件保持 disabled 占位。
      */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">数据管理</CardTitle>
          <CardDescription>导入导出（v1 暂未开放，列入 P1）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 导出（SET-P0-03） */}
          <div className="space-y-2">
            <Label className="text-sm">导出</Label>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 opacity-60">
              {[
                { id: 'exp-cashflow', label: '出入金', checked: true },
                { id: 'exp-trade', label: '证券买卖', checked: true },
                { id: 'exp-price', label: '现价', checked: true },
                { id: 'exp-cash', label: '现金余额', checked: true },
                { id: 'exp-snapshot', label: '总资产记录', checked: true },
                { id: 'exp-nav', label: '每日净值', checked: false },
                { id: 'exp-xirr', label: '每日 XIRR', checked: false },
              ].map((item) => (
                <label
                  key={item.id}
                  htmlFor={item.id}
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <input
                    id={item.id}
                    type="checkbox"
                    className="h-4 w-4 rounded border-input accent-primary"
                    defaultChecked={item.checked}
                    disabled
                  />
                  {item.label}
                </label>
              ))}
            </div>
            <Button variant="outline" size="sm" disabled>
              导出 CSV
            </Button>
          </div>

          {/* 导入（SET-P0-04） */}
          <div className="space-y-2">
            <Label className="text-sm">导入</Label>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled>
                下载模板：出入金
              </Button>
              <Button variant="outline" size="sm" disabled>
                下载模板：证券买卖
              </Button>
              <Button variant="outline" size="sm" disabled>
                下载模板：总资产记录
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled>
                选择文件…
              </Button>
              <Button variant="outline" size="sm" disabled>
                预览前 10 行
              </Button>
              <Button size="sm" disabled>
                开始导入
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            ⓘ 导出 / 导入功能 v1 暂未开放，以上控件仅为界面占位（SET-P0-03 / SET-P0-04）
          </p>
        </CardContent>
      </Card>

      {/* 组合管理 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">组合管理</CardTitle>
            <CardDescription>创建、编辑、归档或删除投资组合</CardDescription>
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
                      <span className="inline-flex items-center gap-2">
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
                        {p.archivedAt && (
                          <span className="text-xs text-muted-foreground">已归档</span>
                        )}
                      </span>
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
                        {/* 设为默认（SET-P0-06）：写偏好 defaultPortfolioId + 切换当前组合 */}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleSetDefaultPortfolio(p)}
                          title={
                            p.archivedAt
                              ? '已归档组合不能设为默认'
                              : isDefaultPortfolio(p.id)
                                ? '当前默认组合'
                                : '设为默认'
                          }
                          aria-label="设为默认"
                          disabled={
                            Boolean(p.archivedAt) ||
                            isDefaultPortfolio(p.id) ||
                            updatePrefsMutation.isPending
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
                          onClick={() => setEditing(p)}
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() =>
                            archiveMutation.mutate({
                              id: p.id,
                              archived: !p.archivedAt,
                            })
                          }
                          title={p.archivedAt ? '取消归档' : '归档'}
                          disabled={archiveMutation.isPending}
                        >
                          <Archive
                            className={cn(
                              'h-4 w-4',
                              p.archivedAt ? 'text-primary' : '',
                            )}
                          />
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

      {/* 危险操作区（SET-P0-05 清空数据 + SET-P1-06 注销账户，语义严格区分） */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base text-destructive">危险操作区</CardTitle>
          <CardDescription>以下操作不可恢复或代价极高，请谨慎执行</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 清空当前组合数据（SET-P0-05）：只清数据、保留组合 */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">清空当前组合数据</p>
              <p className="text-xs text-muted-foreground">
                删除当前组合的全部出入金、证券买卖、净值与 XIRR 等数据，
                但保留组合本身（SET-P0-05）
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setClearDataConfirmName('');
                setClearDataOpen(true);
              }}
              disabled={!currentPortfolio}
              title={currentPortfolio ? undefined : '请先在顶部选择一个组合'}
            >
              清空数据
            </Button>
          </div>

          {/* 注销账户（SET-P1-06）：软删除账户本身及全部数据 */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <div>
              <p className="text-sm font-semibold text-destructive">注销账户</p>
              <p className="text-xs text-muted-foreground">
                软删除账户本身及全部组合；30 天内可在登录页用原邮箱 + 密码自助恢复，
                超期由系统彻底删除（SET-P1-06）
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setDeleteAccountEmail('');
                setDeleteAccountOpen(true);
              }}
            >
              注销账户
            </Button>
          </div>
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

      {/* 注销账户确认（SET-P1-06：邮箱二次确认 + 软删除文案） */}
      <AlertDialog
        open={deleteAccountOpen}
        onOpenChange={setDeleteAccountOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认注销账户？</AlertDialogTitle>
            {/*
              PRD §7.8 L1400-1402 硬约束：本应用**没有人工客服代恢复通道**，
              文案严禁出现「如需恢复请联系客服」，必须写明「自助恢复」口径。
            */}
            <AlertDialogDescription>
              注销将删除账户本身及全部组合（软删除保留 30 天，到期后由系统彻底删除）。
              30 天内可在登录页用原邮箱 + 密码自助恢复；超过 30 天后数据将被系统彻底删除，不可找回。
              此操作与「清空当前组合数据」不同：后者仅清空单个组合数据、保留账户。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-account-email">
              请输入当前邮箱 <span className="font-mono">{user?.email ?? ''}</span> 以确认
            </Label>
            <Input
              id="delete-account-email"
              type="email"
              placeholder={user?.email ?? '请输入当前邮箱'}
              value={deleteAccountEmail}
              onChange={(e) => setDeleteAccountEmail(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAccountMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAccountMutation.mutate()}
              disabled={
                deleteAccountMutation.isPending ||
                deleteAccountEmail.trim() !== (user?.email ?? '')
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteAccountMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              确认注销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 清空当前组合数据确认（SET-P0-05：手动输入组合名称 + 列出删除类型） */}
      <AlertDialog open={clearDataOpen} onOpenChange={setClearDataOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认清空该组合数据？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除组合「{currentPortfolio?.name ?? ''}」下的以下全部数据，
              组合本身保留，此操作不可撤销：
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            <li>出入金流水</li>
            <li>证券买卖流水</li>
            <li>标的最新价 / 现金余额</li>
            <li>总资产记录（快照）</li>
            <li>每日净值 / 每日 XIRR</li>
            <li>分红 / 费用</li>
          </ul>
          <div className="space-y-2">
            <Label htmlFor="clear-data-confirm">
              请输入组合名称 <span className="font-mono">{currentPortfolio?.name ?? ''}</span> 以确认
            </Label>
            <Input
              id="clear-data-confirm"
              placeholder={currentPortfolio?.name ?? '请输入组合名称'}
              value={clearDataConfirmName}
              onChange={(e) => setClearDataConfirmName(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearDataMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (currentPortfolio) {
                  clearDataMutation.mutate(currentPortfolio.id, {
                    onSuccess: () => {
                      setClearDataOpen(false);
                      setClearDataConfirmName('');
                    },
                  });
                }
              }}
              disabled={
                clearDataMutation.isPending ||
                clearDataConfirmName.trim() !== (currentPortfolio?.name ?? '')
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearDataMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              确认清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
