<script setup lang="ts">
/**
 * modules/settings/components/SettingsPreferencesTab.vue — 设置页「偏好设置」TAB 内容
 *（P2-6 文件拆分：SettingsPage 920 行超预算，容器只做 TAB 组合，偏好表单内聚到本组件）
 *
 * 沿用 PrefsDividendTab.vue 先例：组件自持状态，父级只负责 TAB 容器。
 *
 * 【watch 为何用 immediate】reka-ui TabsContent 非激活即卸载：切走再切回会重建本组件，
 * 此时服务端偏好早已加载完毕、普通 watch 不会再触发，表单会退回默认值。immediate
 * 保证「任何时刻挂载」都能立即回填已加载的服务端偏好。
 */
import { computed, reactive, watch } from 'vue';
import { Loader2, Palette } from 'lucide-vue-next';
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
import { Skeleton } from '@/components/ui/skeleton';
import HelpTip from '@/components/common/HelpTip.vue';
import { usePortfolioStore } from '@/stores/portfolio.store';
import {
  usePreferenceStore,
  DEFAULT_PREFERENCES,
} from '@/stores/preference.store';
import {
  usePreferences,
  useUpdatePreferences,
} from '@/modules/overview/composables/use-preferences';
import { usePortfolios } from '@/modules/portfolio/composables/use-portfolios';
import { QUICK_RANGE_OPTIONS } from '@/modules/query/quick-range';
import { AGGREGATION_OPTIONS, GRANULARITY_OPTIONS } from '@/lib/constants';
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

const portfolioStore = usePortfolioStore();
const preferenceStore = usePreferenceStore();
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);

// 组合列表：偏好区「默认组合」下拉需要（vue-query 同 key 共享缓存，与父页重复调用无额外请求）
const portfoliosQuery = usePortfolios();
const portfolios = computed(() => portfoliosQuery.data.value ?? []);

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

// 同步服务端偏好：写入本地 store + 回填表单（immediate：TAB 重建后立即回填）
watch(
  serverPrefs,
  (prefs) => {
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
  },
  { immediate: true },
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
</script>

<template>
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
            录入后提示同步更新现金余额（SET-P0-07）
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

      <!-- 货币 / 语言（待后端集成：降级为 1 行 muted 文本 + HelpTip，删除无交互 disabled 控件） -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label class="text-xs text-muted-foreground">货币</Label>
          <p class="text-sm">人民币（CNY，暂不可改）</p>
        </div>

        <div class="space-y-2">
          <Label class="text-xs text-muted-foreground">语言</Label>
          <div class="flex items-center gap-1.5 text-sm">
            <span>中文（简体，暂不可改）</span>
            <HelpTip text="货币与语言当前跟随服务端默认，待后端集成多币种 / 多语言后开放修改。">
              <template #content>
                <p>货币与语言当前跟随服务端默认。</p>
                <p class="mt-1">待后端集成多币种 / 多语言后开放修改。</p>
              </template>
            </HelpTip>
          </div>
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
</template>
