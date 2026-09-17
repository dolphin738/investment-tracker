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
 *
 * 拆分说明（纯位置拆分）：基础选项字段（默认组合/时间维度/日期范围/聚合/周起始/小数位）
 * 下放到 PreferencesSelectFields.vue；开关与阈值字段（主题/软提示/金额格式/快照阈值）
 * 下放到 PreferencesToggleFields.vue。prefForm 状态与 immediate 回填 watch 仍保留在
 * 本门面，同一 reactive 对象以 props 下发（子组件写回同一对象，行为不变）。
 */
import { computed, reactive, ref, watch } from 'vue';
import { Loader2 } from 'lucide-vue-next';
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
import type { UpdatePreferenceDto } from '@/api/types';
import PreferencesSelectFields from './PreferencesSelectFields.vue';
import PreferencesToggleFields from './PreferencesToggleFields.vue';

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

// 股息率标色阈值（随账号存储）：UI 以「百分数字符串」绑定（可自由输入中间态，如 "0."），
// 保存时再转小数比率。与 prefForm 分开持有，避免把非 DTO 字段混进 PATCH payload。
const greenPercent = ref('');
const redPercent = ref('');

/** 小数比率 → 百分数字符串（0.05 → '5'）；非法 / 缺省返回空串 */
function ratioToPercentStr(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number((n * 100).toFixed(4))) : '';
}

/**
 * 百分数字符串 → 小数比率（空串 / 非法返回 null）。
 *
 * ⚠️ 入参必须容忍 number：`<Input type="number">` 经 Vue 的 vModelText 会把值**自动转成
 * number**（castToNumber = type === 'number'），若在此直接 `t.trim()` 会抛 TypeError，
 * 进而使整块「偏好设置」渲染崩溃（2026-09-17 表现：一输入数字，面板即消失）。
 */
function percentStrToRatio(t: string | number | null | undefined): number | null {
  const s = String(t ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n / 100 : null;
}

/** 输入框回传值归一化为字符串（number 输入框可能回传 number） */
function onGreenPercentInput(v: string | number): void {
  greenPercent.value = String(v ?? '');
}

function onRedPercentInput(v: string | number): void {
  redPercent.value = String(v ?? '');
}

/** 阈值校验（与后端同口径 0 < red < green <= 1）：返回错误文案，null = 合法 */
const thresholdError = computed<string | null>(() => {
  const g = percentStrToRatio(greenPercent.value);
  const r = percentStrToRatio(redPercent.value);
  if (g === null || r === null) return '阈值须为有效数字';
  if (r <= 0) return '低股息线阈值须大于 0';
  if (g > 1) return '高股息线阈值须不大于 100（%）';
  if (r >= g) return '低股息线阈值须小于高股息线阈值';
  return null;
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
    greenPercent.value = ratioToPercentStr(
      prefs.greenThreshold ?? DEFAULT_PREFERENCES.greenThreshold,
    );
    redPercent.value = ratioToPercentStr(
      prefs.redThreshold ?? DEFAULT_PREFERENCES.redThreshold,
    );
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
    prefForm.amountAbbrev !== prefs.amountAbbrev ||
    greenPercent.value !==
      ratioToPercentStr(prefs.greenThreshold ?? DEFAULT_PREFERENCES.greenThreshold) ||
    redPercent.value !==
      ratioToPercentStr(prefs.redThreshold ?? DEFAULT_PREFERENCES.redThreshold)
  );
});

/**
 * 保存偏好（乐观更新）。
 *
 * 「默认组合」是服务端偏好（preference.defaultPortfolioId），界面当前展示哪个组合由
 * portfolio store 的 currentPortfolioId 决定，两者相互独立。保存成功后主动把当前视图
 * 切到新的默认组合，符合用户预期（React 版同口径）。
 */
function handleSavePreferences(): void {
  // 阈值非法时不发请求（错误文案已就地提示，保存按钮也已禁用）
  if (thresholdError.value) return;
  const nextDefault =
    prefForm.defaultPortfolioId === '' ? null : prefForm.defaultPortfolioId;
  const payload: UpdatePreferenceDto = {
    ...prefForm,
    // 空字符串视为 null
    defaultPortfolioId:
      prefForm.defaultPortfolioId === '' ? null : prefForm.defaultPortfolioId,
    greenThreshold: percentStrToRatio(greenPercent.value) ?? undefined,
    redThreshold: percentStrToRatio(redPercent.value) ?? undefined,
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
      <PreferencesSelectFields
        :pref-form="prefForm"
        :portfolios="portfolios"
      />
      <PreferencesToggleFields :pref-form="prefForm" />

      <!-- 股息率标色阈值（随账号存储；原「设置 → 股息率」的全局阈值迁至此） -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label for="pref-green-threshold">高股息线阈值（%）</Label>
          <Input
            id="pref-green-threshold"
            type="number"
            min="0"
            max="100"
            step="0.1"
            class="w-full"
            :model-value="greenPercent"
            @update:model-value="onGreenPercentInput"
          />
          <p class="text-xs text-muted-foreground">
            股息率 ≥ 此值视为「高股息」（标红），并作为股息率曲线图的高股息线
          </p>
        </div>

        <div class="space-y-2">
          <Label for="pref-red-threshold">低股息线阈值（%）</Label>
          <Input
            id="pref-red-threshold"
            type="number"
            min="0"
            max="100"
            step="0.1"
            class="w-full"
            :model-value="redPercent"
            @update:model-value="onRedPercentInput"
          />
          <p class="text-xs text-muted-foreground">
            股息率 ≤ 此值视为「低股息」（标绿），须小于高股息线阈值
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
          :disabled="!hasPrefChanges || updatePending || !!thresholdError"
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
        <span v-if="thresholdError" class="text-xs text-red-500">
          {{ thresholdError }}
        </span>
        <span v-if="updateError" class="text-xs text-red-500">
          保存失败，请重试
        </span>
      </div>
        </div>
      </CardContent>
    </Card>
</template>
