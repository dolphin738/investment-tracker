<script setup lang="ts">
/**
 * modules/settings/pages/SettingsPage.vue — 设置页
 *
 * 自 React 版 web/src/pages/settings.tsx 平移，包含：
 * - 账户：用户信息摘要 + 操作入口（修改邮箱 / 修改密码 / 编辑资料 / 退出登录）
 * - 偏好设置：服务端持久化（usePreferences + 乐观更新 useUpdatePreferences）
 * - 数据管理：导出 / 导入（B13 批次已接入，本页保留）
 * - 危险操作区：清空当前组合数据 / 注销账户（AlertDialog 二次确认）
 *
 * 组合管理（新建 / 编辑 / 归档 / 删除 / 设为默认）已整体迁出本页，
 * 收敛到账户页 /account 的「我的组合」卡；本页仅读取组合列表供
 * 「默认组合」下拉与导出 / 导入 / 清空数据使用。
 *
 * 【偏好同步口径】与 React 版一致：
 * - 服务端偏好加载后写入 preference.store（全站共享），并回填本地表单；
 * - 修改后点「保存偏好」乐观更新（失败回滚），成功后覆盖偏好 store 并切默认组合；
 * - QUICK_RANGE_OPTIONS / RESOLVED 统一取自 '@/modules/query/quick-range'（唯一真相源）。
 */
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Loader2, Lock, LogOut, Mail, Palette, Pencil } from 'lucide-vue-next';
import PageHeader from '@/components/common/PageHeader.vue';
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
import UserAvatar from '@/components/common/UserAvatar.vue';
import ExportPanel from '@/modules/data-transfer/components/ExportPanel.vue';
import ImportDialog from '@/modules/data-transfer/components/ImportDialog.vue';
import ImportTemplateButtons from '@/modules/data-transfer/components/ImportTemplateButtons.vue';
import ChangeEmailDialog from '@/modules/account/components/ChangeEmailDialog.vue';
import ChangePasswordDialog from '@/modules/account/components/ChangePasswordDialog.vue';
import EditProfileDialog from '@/modules/account/components/EditProfileDialog.vue';
import { useAuthStore } from '@/stores/auth.store';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore, DEFAULT_PREFERENCES } from '@/stores/preference.store';
import {
  usePreferences,
  useUpdatePreferences,
} from '@/modules/overview/composables/use-preferences';
import {
  useClearPortfolioData,
  usePortfolios,
} from '@/modules/portfolio/composables/use-portfolios';
import { useDeleteAccount } from '@/modules/account/composables/use-account';
import { QUICK_RANGE_OPTIONS } from '@/modules/query/quick-range';
import { ROUTE_PATH, AGGREGATION_OPTIONS, GRANULARITY_OPTIONS } from '@/lib/constants';
import type { UpdatePreferenceDto } from '@/api/types';

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

const router = useRouter();
const authStore = useAuthStore();
const user = computed(() => authStore.user);
const portfolioStore = usePortfolioStore();
const preferenceStore = usePreferenceStore();

// 组合列表仍需读取：偏好区「默认组合」下拉、导出面板、导入对话框、清空数据都依赖它。
const portfoliosQuery = usePortfolios();
const portfolios = computed(() => portfoliosQuery.data.value ?? []);
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
const currentPortfolio = computed(
  () => portfolios.value.find((p) => p.id === currentPortfolioId.value) ?? null,
);

// 数据管理：导入对话框开关（T05）
const importOpen = ref(false);

// 偏好 hooks（乐观更新）
const preferencesQuery = usePreferences();
const serverPrefs = computed(() => preferencesQuery.data.value);
const prefsLoading = computed(() => preferencesQuery.isLoading.value);
const updatePrefsMutation = useUpdatePreferences();
const updatePending = computed(() => updatePrefsMutation.isPending.value);
const updateError = computed(() => updatePrefsMutation.isError.value);

// 本地偏好编辑状态（乐观更新）
const prefForm = reactive({
  defaultPortfolioId: '',
  defaultGranularity: DEFAULT_PREFERENCES.defaultGranularity,
  defaultDateRange: DEFAULT_PREFERENCES.defaultDateRange,
  aggregation: DEFAULT_PREFERENCES.aggregation,
  weekStartsOn: DEFAULT_PREFERENCES.weekStartsOn,
  navDecimals: DEFAULT_PREFERENCES.navDecimals,
  xirrDecimals: DEFAULT_PREFERENCES.xirrDecimals,
  theme: DEFAULT_PREFERENCES.theme,
  staleDays: DEFAULT_PREFERENCES.staleDays,
  cashHintOnCashflow: DEFAULT_PREFERENCES.cashHintOnCashflow,
  cashHintOnTrade: DEFAULT_PREFERENCES.cashHintOnTrade,
  amountThousands: DEFAULT_PREFERENCES.amountThousands,
  amountAbbrev: DEFAULT_PREFERENCES.amountAbbrev,
});

// 同步服务端偏好：写入本地 store + 回填表单
watch(serverPrefs, (prefs) => {
  if (!prefs) return;
  preferenceStore.setPreferences(prefs);
  prefForm.defaultPortfolioId = prefs.defaultPortfolioId ?? '';
  prefForm.defaultGranularity = prefs.defaultGranularity;
  prefForm.defaultDateRange = prefs.defaultDateRange;
  prefForm.aggregation = prefs.aggregation;
  prefForm.weekStartsOn = prefs.weekStartsOn;
  prefForm.navDecimals = prefs.navDecimals;
  prefForm.xirrDecimals = prefs.xirrDecimals;
  prefForm.theme = prefs.theme;
  prefForm.staleDays = prefs.staleDays;
  prefForm.cashHintOnCashflow = prefs.cashHintOnCashflow;
  prefForm.cashHintOnTrade = prefs.cashHintOnTrade;
  prefForm.amountThousands = prefs.amountThousands;
  prefForm.amountAbbrev = prefs.amountAbbrev;
});

// 账户修改对话框显隐
const emailDialogOpen = ref(false);
const passwordDialogOpen = ref(false);
const profileDialogOpen = ref(false);

// 注销账户（危险操作 · SET-P1-06）
const deleteAccountOpen = ref(false);
const deleteAccountEmail = ref('');
const deleteAccountMutation = useDeleteAccount();

// 清空当前组合数据（危险操作 · SET-P0-05）
const clearDataOpen = ref(false);
const clearDataConfirmName = ref('');
const clearDataMutation = useClearPortfolioData();

/** 手机号脱敏展示 */
const maskedPhone = computed(() =>
  user.value?.phone
    ? `${user.value.phone.slice(0, 3)}****${user.value.phone.slice(7)}`
    : '-',
);

/** 偏好是否有变更（与服务端对比） */
const hasPrefChanges = computed(() => {
  const prefs = serverPrefs.value;
  if (!prefs) return false;
  return (
    prefForm.defaultPortfolioId !== (prefs.defaultPortfolioId ?? '') ||
    prefForm.defaultGranularity !== prefs.defaultGranularity ||
    prefForm.defaultDateRange !== prefs.defaultDateRange ||
    prefForm.aggregation !== prefs.aggregation ||
    prefForm.weekStartsOn !== prefs.weekStartsOn ||
    prefForm.navDecimals !== prefs.navDecimals ||
    prefForm.xirrDecimals !== prefs.xirrDecimals ||
    prefForm.theme !== prefs.theme ||
    prefForm.staleDays !== prefs.staleDays ||
    prefForm.cashHintOnCashflow !== prefs.cashHintOnCashflow ||
    prefForm.cashHintOnTrade !== prefs.cashHintOnTrade ||
    prefForm.amountThousands !== prefs.amountThousands ||
    prefForm.amountAbbrev !== prefs.amountAbbrev
  );
});

/** Select 数值字段适配（string ↔ number） */
const navDecimalsModel = computed<string>({
  get: () => String(prefForm.navDecimals),
  set: (v) => {
    prefForm.navDecimals = Number(v);
  },
});
const xirrDecimalsModel = computed<string>({
  get: () => String(prefForm.xirrDecimals),
  set: (v) => {
    prefForm.xirrDecimals = Number(v);
  },
});

/** 周起始日 RadioGroup 适配（string ↔ number） */
const weekStartsOnModel = computed<string>({
  get: () => String(prefForm.weekStartsOn),
  set: (v) => {
    prefForm.weekStartsOn = Number(v);
  },
});

/** 默认组合 Select 适配（哨兵 '__none__' ↔ 空串） */
const defaultPortfolioIdModel = computed<string>({
  get: () => prefForm.defaultPortfolioId || '__none__',
  set: (v) => {
    prefForm.defaultPortfolioId = v === '__none__' ? '' : v;
  },
});

/** 快照过期阈值输入（1~30 天数钳制） */
function onStaleInput(event: Event): void {
  const v = Number((event.target as HTMLInputElement).value);
  if (v >= 1 && v <= 30) prefForm.staleDays = v;
}

/** 退出登录 */
function handleLogout(): void {
  authStore.logout();
  router.push(ROUTE_PATH.LOGIN);
}

/**
 * 保存偏好（乐观更新）。
 *
 * 「默认组合」是服务端偏好（preference.defaultPortfolioId），界面当前展示哪个组合由
 * portfolio store 的 currentPortfolioId 决定，两者相互独立。保存成功后主动把当前视图
 * 切到新的默认组合，符合用户预期（React 版同口径）。
 */
function handleSavePreferences(): void {
  const nextDefault =
    prefForm.defaultPortfolioId === '' ? null : prefForm.defaultPortfolioId;
  const payload: UpdatePreferenceDto = {
    ...prefForm,
    // 空字符串视为 null
    defaultPortfolioId:
      prefForm.defaultPortfolioId === '' ? null : prefForm.defaultPortfolioId,
  };
  updatePrefsMutation.mutate(payload, {
    onSuccess: () => {
      // 选择「不设置」时不动当前视图，只有明确指定了新默认组合才切换
      if (nextDefault && nextDefault !== currentPortfolioId.value) {
        portfolioStore.setCurrentPortfolio(nextDefault);
      }
    },
  });
}

/** 确认清空当前组合数据 */
function confirmClearData(): void {
  if (!currentPortfolio.value) return;
  clearDataMutation.mutate(currentPortfolio.value.id, {
    onSuccess: () => {
      clearDataOpen.value = false;
      clearDataConfirmName.value = '';
    },
  });
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="设置"
      description="管理账户与偏好设置（新建 / 编辑 / 归档 / 删除组合请前往账户页「我的组合」）"
    />

    <!-- 账户 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">账户</CardTitle>
        <CardDescription>当前登录用户信息与安全设置</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- 头像 + 昵称 + 邮箱 + 账户中心入口（§7.8 L1315） -->
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
          <UserAvatar
            size="lg"
            :src="user?.avatar"
            :name="user?.name"
            :email="user?.email ?? ''"
          />
          <div class="min-w-0">
            <p class="truncate text-base font-medium">
              {{ user?.name || '未设置' }}
            </p>
            <p class="truncate text-sm text-muted-foreground">
              {{ user?.email ?? '-' }}
            </p>
          </div>
          <Button
            variant="link"
            size="sm"
            class="sm:ml-auto"
            @click="router.push(ROUTE_PATH.ACCOUNT)"
          >
            前往账户中心 →
          </Button>
        </div>

        <!-- 资料明细 -->
        <div class="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <Label class="text-xs text-muted-foreground">手机号</Label>
            <p class="mt-1 font-mono">{{ maskedPhone }}</p>
          </div>
          <div>
            <Label class="text-xs text-muted-foreground">个人简介</Label>
            <p class="mt-1 whitespace-pre-wrap break-words">
              {{ user?.bio || '-' }}
            </p>
          </div>
        </div>

        <!-- 操作区 -->
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="emailDialogOpen = true">
            <Mail class="mr-2 h-4 w-4" />
            修改邮箱
          </Button>
          <Button variant="outline" size="sm" @click="passwordDialogOpen = true">
            <Lock class="mr-2 h-4 w-4" />
            修改密码
          </Button>
          <Button variant="outline" size="sm" @click="profileDialogOpen = true">
            <Pencil class="mr-2 h-4 w-4" />
            编辑资料
          </Button>
          <Button variant="outline" size="sm" @click="handleLogout">
            <LogOut class="mr-2 h-4 w-4" />
            退出登录
          </Button>
        </div>

        <!-- 头像修改提示（§7.8 L1318-1319） -->
        <p class="text-xs text-muted-foreground">
          Ⓘ 头像修改在「编辑资料」卡片内完成（本地上传 与 头像 URL 并列）；本区只展示头像，不提供独立的「头像 URL」输入框
        </p>
      </CardContent>
    </Card>

    <!-- 偏好设置 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">偏好设置</CardTitle>
        <CardDescription>
          偏好跟随账号存储，换设备登录仍生效
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="prefsLoading" class="space-y-3">
          <Skeleton v-for="i in 5" :key="i" class="h-10 w-full" />
        </div>
        <div v-else class="space-y-6">
          <!-- 默认组合 -->
          <div class="space-y-2">
            <Label for="pref-portfolio">默认组合</Label>
            <Select v-model="defaultPortfolioIdModel">
              <SelectTrigger id="pref-portfolio" class="w-[260px]">
                <SelectValue placeholder="选择默认组合" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">不设置</SelectItem>
                <SelectItem
                  v-for="p in portfolios.filter((x) => !x.archivedAt)"
                  :key="p.id"
                  :value="p.id"
                >
                  {{ p.name }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              登录后自动选中该组合；组合本身的新建 / 编辑 / 归档 / 删除在账户页「我的组合」完成
            </p>
          </div>

          <!-- 默认时间维度 + 日期范围（并排） -->
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="pref-granularity">默认时间维度</Label>
              <Select v-model="prefForm.defaultGranularity">
                <SelectTrigger id="pref-granularity" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="opt in GRANULARITY_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-2">
              <Label for="pref-daterange">默认日期范围</Label>
              <Select v-model="prefForm.defaultDateRange">
                <SelectTrigger id="pref-daterange" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="opt in QUICK_RANGE_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <!-- 聚合方式 + 周起始日（并排） -->
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="pref-aggregation">周期聚合方式</Label>
              <Select v-model="prefForm.aggregation">
                <SelectTrigger id="pref-aggregation" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="opt in AGGREGATION_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-2">
              <Label>周起始日</Label>
              <RadioGroup v-model="weekStartsOnModel" orientation="horizontal">
                <RadioGroupItem value="1" label="周一" />
                <RadioGroupItem value="0" label="周日" />
              </RadioGroup>
            </div>
          </div>

          <!-- 小数位设置（并排） -->
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="pref-navdec">净值小数位</Label>
              <Select v-model="navDecimalsModel">
                <SelectTrigger id="pref-navdec" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="opt in DECIMAL_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-2">
              <Label for="pref-xirrdec">XIRR 小数位</Label>
              <Select v-model="xirrDecimalsModel">
                <SelectTrigger id="pref-xirrdec" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="opt in XIRR_DECIMAL_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <!-- 外观主题 / 软提示开关 / 金额格式 / 快照过期阈值：四块横排 -->
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <!-- 外观主题 -->
            <div class="space-y-2">
              <Label class="flex items-center gap-2">
                <Palette class="h-4 w-4" />
                外观主题
              </Label>
              <RadioGroup v-model="prefForm.theme" orientation="horizontal">
                <RadioGroupItem
                  v-for="opt in THEME_OPTIONS"
                  :key="opt.value"
                  :value="opt.value"
                  :label="opt.label"
                />
              </RadioGroup>
              <p class="text-xs text-muted-foreground">
                选择「跟随系统」将根据操作系统设置自动切换
              </p>
            </div>

            <!-- 软提示开关（SET-P0-07 · §7.8 L1376） -->
            <div class="space-y-2">
              <Label>软提示开关</Label>
              <div class="flex flex-wrap items-center gap-4">
                <label
                  for="pref-hint-cashflow"
                  class="inline-flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    id="pref-hint-cashflow"
                    v-model="prefForm.cashHintOnCashflow"
                    type="checkbox"
                    class="h-4 w-4 rounded border-input accent-primary"
                  />
                  出入金后提示
                </label>
                <label
                  for="pref-hint-trade"
                  class="inline-flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    id="pref-hint-trade"
                    v-model="prefForm.cashHintOnTrade"
                    type="checkbox"
                    class="h-4 w-4 rounded border-input accent-primary"
                  />
                  买卖后提示
                </label>
              </div>
              <p class="text-xs text-muted-foreground">
                录入后提示同步更新现金余额（SET-P0-07，即将上线）
              </p>
            </div>

            <!-- 金额格式（SET-P1-03 · §7.8 L1377） -->
            <div class="space-y-2">
              <Label>金额格式</Label>
              <div class="flex flex-wrap items-center gap-4">
                <label
                  for="pref-amount-thousands"
                  class="inline-flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    id="pref-amount-thousands"
                    v-model="prefForm.amountThousands"
                    type="checkbox"
                    class="h-4 w-4 rounded border-input accent-primary"
                  />
                  千分位
                </label>
                <label
                  for="pref-amount-abbrev"
                  class="inline-flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    id="pref-amount-abbrev"
                    v-model="prefForm.amountAbbrev"
                    type="checkbox"
                    class="h-4 w-4 rounded border-input accent-primary"
                  />
                  万 / 亿缩写
                </label>
              </div>
              <p class="text-xs text-muted-foreground">
                金额展示格式（SET-P1-03），已全站接入
              </p>
            </div>

            <!-- 快照过期阈值 -->
            <div class="space-y-2">
              <Label for="pref-stale">快照过期提醒阈值（天）</Label>
              <Input
                id="pref-stale"
                type="number"
                min="1"
                max="30"
                class="w-full"
                :model-value="prefForm.staleDays"
                @input="onStaleInput"
              />
              <p class="text-xs text-muted-foreground">
                资产快照超过此天数未更新时显示提醒（1~30 天）
              </p>
            </div>
          </div>

          <!-- 货币 / 语言（待后端集成） -->
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="pref-currency">货币</Label>
              <Select disabled :model-value="'CNY'">
                <SelectTrigger id="pref-currency" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CNY">人民币 (CNY)</SelectItem>
                </SelectContent>
              </Select>
              <p class="text-xs text-muted-foreground">
                待后端集成（当前仅支持 CNY）
              </p>
            </div>

            <div class="space-y-2">
              <Label for="pref-lang">语言</Label>
              <Select disabled :model-value="'zh-CN'">
                <SelectTrigger id="pref-lang" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zh-CN">中文（简体）</SelectItem>
                </SelectContent>
              </Select>
              <p class="text-xs text-muted-foreground">
                待后端集成（当前仅支持中文）
              </p>
            </div>
          </div>

          <!-- 保存按钮 -->
          <div class="flex items-center gap-3 pt-2">
            <Button
              :disabled="!hasPrefChanges || updatePending"
              @click="handleSavePreferences"
            >
              <Loader2
                v-if="updatePending"
                class="mr-2 h-4 w-4 animate-spin"
              />
              保存偏好
            </Button>
            <span
              v-if="!hasPrefChanges && serverPrefs"
              class="text-xs text-muted-foreground"
            >
              已是最新
            </span>
            <span v-if="updateError" class="text-xs text-red-500">
              保存失败，请重试
            </span>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 数据管理（T05 · SET-P0-03 导出 / SET-P0-04 导入 / FLOW-P1-01） -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">数据管理</CardTitle>
        <CardDescription>
          CSV / Excel 导出与导入（导入支持 .csv / .xlsx / .xls）
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- 导出（SET-P0-03）：7 类多选 + 格式 + 串行下载 -->
        <div class="space-y-2">
          <Label class="text-sm">导出</Label>
          <ExportPanel
            v-if="currentPortfolio"
            :portfolio-id="currentPortfolio.id"
            :portfolio-name="currentPortfolio.name"
          />
          <p v-else class="text-xs text-muted-foreground">
            请先在顶部选择一个投资组合
          </p>
        </div>

        <!-- 导入（SET-P0-04 / FLOW-P1-01）：预览 → 提交 -->
        <div class="space-y-2">
          <Label class="text-sm">导入</Label>
          <div class="flex flex-wrap items-center gap-2">
            <ImportTemplateButtons />
            <Button
              variant="outline"
              size="sm"
              :disabled="!currentPortfolio"
              @click="importOpen = true"
            >
              选择文件并导入…
            </Button>
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          Ⓘ 导入前建议先「导出」备份；证券买卖 / 出入金为追加写入，资产快照按日期覆盖。
        </p>
      </CardContent>
    </Card>

    <!-- 导入对话框 -->
    <ImportDialog
      :portfolio-id="currentPortfolioId ?? ''"
      :open="importOpen"
      @open-change="importOpen = $event"
    />

    <!-- 危险操作区（SET-P0-05 清空数据 + SET-P1-06 注销账户） -->
    <Card class="border-destructive/40">
      <CardHeader>
        <CardTitle class="text-base text-destructive">危险操作区</CardTitle>
        <CardDescription>以下操作不可恢复或代价极高，请谨慎执行</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- 清空当前组合数据（SET-P0-05）：只清数据、保留组合 -->
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-sm font-medium">清空当前组合数据</p>
            <p class="text-xs text-muted-foreground">
              删除当前组合的全部出入金、证券买卖、净值与 XIRR 等数据，
              但保留组合本身（SET-P0-05）
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            class="text-destructive hover:text-destructive"
            :disabled="!currentPortfolio"
            :title="currentPortfolio ? undefined : '请先在顶部选择一个组合'"
            @click="
              clearDataConfirmName = '';
              clearDataOpen = true;
            "
          >
            清空数据
          </Button>
        </div>

        <!-- 注销账户（SET-P1-06）：软删除账户本身及全部数据 -->
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <div>
            <p class="text-sm font-semibold text-destructive">注销账户</p>
            <p class="text-xs text-muted-foreground">
              软删除账户本身及全部组合；30 天内可在登录页用原邮箱 + 密码自助恢复，
              超期由系统彻底删除（SET-P1-06）
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            @click="
              deleteAccountEmail = '';
              deleteAccountOpen = true;
            "
          >
            注销账户
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- 账户修改对话框 -->
    <ChangeEmailDialog
      :open="emailDialogOpen"
      @open-change="emailDialogOpen = $event"
    />
    <ChangePasswordDialog
      :open="passwordDialogOpen"
      @open-change="passwordDialogOpen = $event"
    />
    <EditProfileDialog
      :open="profileDialogOpen"
      @open-change="profileDialogOpen = $event"
    />

    <!-- 注销账户确认（SET-P1-06：邮箱二次确认 + 软删除文案） -->
    <AlertDialog
      v-model:open="deleteAccountOpen"
      @update:open="deleteAccountOpen = $event"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认注销账户？</AlertDialogTitle>
          <!--
            PRD §7.8 L1400-1402 硬约束：本应用没有人工客服代恢复通道，
            文案严禁出现「如需恢复请联系客服」，必须写明「自助恢复」口径。
          -->
          <AlertDialogDescription>
            注销将删除账户本身及全部组合（软删除保留 30 天，到期后由系统彻底删除）。
            30 天内可在登录页用原邮箱 + 密码自助恢复；超过 30 天后数据将被系统彻底删除，不可找回。
            此操作与「清空当前组合数据」不同：后者仅清空单个组合数据、保留账户。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div class="space-y-2">
          <Label for="delete-account-email">
            请输入当前邮箱
            <span class="font-mono">{{ user?.email ?? '' }}</span>
            以确认
          </Label>
          <Input
            id="delete-account-email"
            type="email"
            :placeholder="user?.email ?? '请输入当前邮箱'"
            v-model="deleteAccountEmail"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            :disabled="deleteAccountMutation.isPending.value"
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="
              deleteAccountMutation.isPending.value ||
              deleteAccountEmail.trim() !== (user?.email ?? '')
            "
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="deleteAccountMutation.mutate()"
          >
            <Loader2
              v-if="deleteAccountMutation.isPending.value"
              class="mr-2 h-4 w-4 animate-spin"
            />
            确认注销
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 清空当前组合数据确认（SET-P0-05：手动输入组合名称 + 列出删除类型） -->
    <AlertDialog v-model:open="clearDataOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认清空该组合数据？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除组合「{{ currentPortfolio?.name ?? '' }}」下的以下全部数据，
            组合本身保留，此操作不可撤销：
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul class="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
          <li>出入金流水</li>
          <li>证券买卖流水</li>
          <li>标的最新价 / 现金余额</li>
          <li>总资产记录（快照）</li>
          <li>每日净值 / 每日 XIRR</li>
          <li>分红 / 费用</li>
        </ul>
        <div class="space-y-2">
          <Label for="clear-data-confirm">
            请输入组合名称
            <span class="font-mono">{{ currentPortfolio?.name ?? '' }}</span>
            以确认
          </Label>
          <Input
            id="clear-data-confirm"
            :placeholder="currentPortfolio?.name ?? '请输入组合名称'"
            v-model="clearDataConfirmName"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            :disabled="clearDataMutation.isPending.value"
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="
              clearDataMutation.isPending.value ||
              clearDataConfirmName.trim() !== (currentPortfolio?.name ?? '')
            "
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="confirmClearData"
          >
            <Loader2
              v-if="clearDataMutation.isPending.value"
              class="mr-2 h-4 w-4 animate-spin"
            />
            确认清空
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>