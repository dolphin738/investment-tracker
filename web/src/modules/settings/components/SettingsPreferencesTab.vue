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
import { computed, reactive, watch } from 'vue';
import { Loader2 } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
      <PreferencesSelectFields
        :pref-form="prefForm"
        :portfolios="portfolios"
      />
      <PreferencesToggleFields :pref-form="prefForm" />

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
