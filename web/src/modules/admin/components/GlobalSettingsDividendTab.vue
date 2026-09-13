<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendTab.vue — 全局设置页「股息率」TAB 内容
 * （方案 §10.4：股息率设置整体从设置页迁出，本组件承载全部股息率配置逻辑；
 * 原 PrefsDividendTab 迁移而来，并新增「公司公告接口」可配置项 §5.4）
 *
 * 阈值 + 主数据源/明细源 + 行情源 + 公司公告源接口配置；admin-only（由父级页面 v-if 保证，
 * 后端仍 403 兜底）。P2-8：UI 用百分数展示（如 5 = 5%），提交时转换为小数比率（§2.4）。
 */
import { computed, reactive, ref, watch } from 'vue';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-vue-next';
import {
  useDividendYieldInterfaces,
  useDividendYieldSettings,
  useUpdateDividendYieldSettings,
} from '@/modules/dividend-yield/composables/use-dividend-yield';
import { useQuoteProviders } from '@/modules/admin/composables/use-quote-provider';
import { PRICE_BACKFILL_MODE_LEGACY, SELECT_EMPTY_VALUE } from '@/lib/constants';
import type { UpdateDividendYieldSettingsDto } from '@/api/types';
import GlobalSettingsDividendInitSection from './GlobalSettingsDividendInitSection.vue';

const settingsQuery = useDividendYieldSettings(true);
const dividendSettings = computed(() => settingsQuery.data.value);
const settingsLoading = computed(() => settingsQuery.isLoading.value);
const settingsMutation = useUpdateDividendYieldSettings();
const settingsPending = computed(() => settingsMutation.isPending.value);
const settingsError = computed(() => settingsMutation.isError.value);

// 四源候选接口（复用 listAllInterfaces，前端按 category_id 过滤）
const interfacesQuery = useDividendYieldInterfaces(true);
const category3Enabled = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '3' && i.enabled),
);
/** 股息主源 / 补充源候选（category_id === '3'；主源限按报告期全量形态由后端四重校验兜底） */
const dividendSourceOptions = category3Enabled;
const dividendDetailOptions = category3Enabled;
/** 行情源候选（category_id === '2'） */
const priceSourceOptions = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '2' && i.enabled),
);
/** 公司公告源候选（category_id === '4' && enabled） */
const announcementSourceOptions = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '4' && i.enabled),
);
/** 历史行情回补接口候选（category_id === '2' && enabled；契约：证券行情分类） */
const priceBackfillSourceOptions = computed(() =>
  (interfacesQuery.data.value ?? []).filter((i) => i.category_id === '2' && i.enabled),
);
/** 回补接口候选项（id + 拼接好 label），供 GlobalSettingsDividendInitSection 哑组件渲染 */
const priceBackfillInterfaceOptions = computed(() =>
  priceBackfillSourceOptions.value.map((i) => ({
    id: i.id,
    label: `${i.name}（${providerNameById.value.get(i.provider_id) ?? '未知提供方'}）`,
  })),
);

// 提供方 id → 名称：四个源下拉展示接口归属（如「东财-分红配送（东方财富）」）
const { data: providers } = useQuoteProviders();
const providerNameById = computed(() => {
  const m = new Map<string, string>();
  (providers.value ?? []).forEach((p) => m.set(p.id, p.name));
  return m;
});

// 股息率设置本地表单：阈值以**百分数**存储（5 = 5%），提交时转小数（P2-8 / §2.4）。
// 四个接口下拉的「不设置」用 SELECT_EMPTY_VALUE 表示（reka-ui 禁止 value=""）。
const settingsForm = reactive({
  greenPercent: '',
  redPercent: '',
  dividendReportSourceInterfaceId: SELECT_EMPTY_VALUE,
  dividendDetailSourceInterfaceId: SELECT_EMPTY_VALUE,
  priceSourceInterfaceId: SELECT_EMPTY_VALUE,
  announcementSourceInterfaceId: SELECT_EMPTY_VALUE,
  priceBackfillSourceInterfaceId: SELECT_EMPTY_VALUE,
  /** 每日回补额度（只/天）；按 greenPercent/redPercent 同款字符串型写法，保存时转 number（默认 1000 与后端一致） */
  priceBackfillQuota: '1000',
  /** 回补起始日期配置默认值（YYYY-MM-DD）；随设置保存、触发回补以其为起点；默认一年前 */
  priceBackfillStartDate: oneYearAgoIso(),
  /** 历史行情回补模式：'legacy'（起点覆盖即跳过，不补空洞）| 'gap'（严格补洞）；
   *  默认 'legacy' 与后端 server_default 一致 */
  priceBackfillMode: PRICE_BACKFILL_MODE_LEGACY,
  /** 交易日历刷新起始日期（YYYY-MM-DD）；空串 = 未配置（后端默认「去年 1 月 1 日」） */
  tradeCalendarStartDate: '',
});
const settingsFormError = ref('');

/** 表单下拉值 → 提交值：哨兵 / 空串一律视为「不设置」（null）。 */
function toInterfaceIdOrNull(v: string): string | null {
  return v === SELECT_EMPTY_VALUE ? null : v || null;
}

/** 回补起始日期默认「一年前的今天」（ISO YYYY-MM-DD）；用户可在设置中保存偏好起点 */
function oneYearAgoIso(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** 小数比率 → 百分数字符串（0.05 → "5"） */
function ratioToPercent(v: number | null): string {
  return v != null ? String(Number((v * 100).toFixed(4))) : '';
}

// immediate 必填：父页以 v-if 卸载非激活 TAB，vue-query 缓存命中时重挂载不再触发
// 变更，非 immediate 的 watch 不会回填（同 SettingsPreferencesTab 已修的坑）。
watch(
  dividendSettings,
  (s) => {
    if (!s) return;
    settingsForm.greenPercent = ratioToPercent(s.green_threshold);
    settingsForm.redPercent = ratioToPercent(s.red_threshold);
    settingsForm.dividendReportSourceInterfaceId =
      s.dividend_report_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.dividendDetailSourceInterfaceId =
      s.dividend_detail_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.priceSourceInterfaceId = s.price_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.announcementSourceInterfaceId =
      s.announcement_source?.id ?? SELECT_EMPTY_VALUE;
    settingsForm.priceBackfillSourceInterfaceId =
      s.price_backfill_source?.id ?? SELECT_EMPTY_VALUE;
    // 每日回补额度：服务端 null 时按后端默认 1000 兜底（与保存 payload 口径一致）
    settingsForm.priceBackfillQuota =
      s.price_backfill_quota != null ? String(s.price_backfill_quota) : '1000';
    // 回补起始日期配置默认值：服务端 null 时回退一年前（与 settingsForm 初值口径一致，避免误报变更）
    settingsForm.priceBackfillStartDate =
      s.price_backfill_default_start_date ?? oneYearAgoIso();
    // 回补模式：服务端空值兜底 legacy（列有 server_default，防御旧行/脏数据）
    settingsForm.priceBackfillMode = s.price_backfill_mode || PRICE_BACKFILL_MODE_LEGACY;
    // 交易日历刷新起始日期：服务端 null → 空串（未配置，后端用默认下限）
    settingsForm.tradeCalendarStartDate = s.trade_calendar_start_date ?? '';
  },
  { immediate: true },
);

/** 百分数字符串 → 小数比率 / null（空串视为 null；非法输入返回 undefined 触发校验错误） */
function percentToRatio(v: string): { ratio: number | null; invalid: boolean } {
  const t = v.trim();
  if (t === '') return { ratio: null, invalid: false };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ratio: null, invalid: true };
  return { ratio: n / 100, invalid: false };
}

/** 每日回补额度字符串 → number | null（空串视为 null；非整数返回 invalid 触发校验错误） */
function quotaToValue(v: string): { value: number | null; invalid: boolean } {
  const t = v.trim();
  if (t === '') return { value: null, invalid: false };
  const n = Number(t);
  if (!Number.isInteger(n)) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

/** 阈值前置校验（后端也会 400：0 < red < green <= 1，即百分数 0 < red% < green% <= 100） */
function validateSettings(): string | null {
  const green = percentToRatio(settingsForm.greenPercent);
  const red = percentToRatio(settingsForm.redPercent);
  if (green.invalid || red.invalid) return '阈值须为有效数字';
  if (green.ratio !== null && green.ratio <= 0) return '绿色阈值须大于 0';
  if (green.ratio !== null && green.ratio > 1) return '绿色阈值须不大于 100（%）';
  if (red.ratio !== null && red.ratio <= 0) return '红色阈值须大于 0';
  if (red.ratio !== null && red.ratio > 1) return '红色阈值须不大于 100（%）';
  if (red.ratio !== null && green.ratio !== null && red.ratio >= green.ratio) {
    return '红色阈值须小于绿色阈值';
  }
  // 每日回补额度（只/天）：后端校验 1..2000 整数，越界返回 400；空串视为 null（用后端默认）
  const q = quotaToValue(settingsForm.priceBackfillQuota);
  if (q.invalid) return '每日回补额度须为整数';
  if (q.value !== null && (q.value < 1 || q.value > 2000)) {
    return '每日回补额度须为 1 到 2000 之间的整数';
  }
  return null;
}

/** 股息率设置是否有本地变更（与服务端对比，阈值按百分数口径比较） */
const settingsHasChanges = computed(() => {
  const s = dividendSettings.value;
  if (!s) return false;
  return (
    settingsForm.greenPercent !== ratioToPercent(s.green_threshold) ||
    settingsForm.redPercent !== ratioToPercent(s.red_threshold) ||
    settingsForm.dividendReportSourceInterfaceId !==
      (s.dividend_report_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.dividendDetailSourceInterfaceId !==
      (s.dividend_detail_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.priceSourceInterfaceId !==
      (s.price_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.announcementSourceInterfaceId !==
      (s.announcement_source?.id ?? SELECT_EMPTY_VALUE) ||
    settingsForm.priceBackfillSourceInterfaceId !==
      (s.price_backfill_source?.id ?? SELECT_EMPTY_VALUE) ||
    // 每日回补额度：服务端 null 时按后端默认 1000 兜底，与 watch 回填口径一致
    settingsForm.priceBackfillQuota !==
      (s.price_backfill_quota != null ? String(s.price_backfill_quota) : '1000') ||
    // 回补起始日期配置默认值：服务端 null 时回退一年前，与 watch 回填口径一致
    settingsForm.priceBackfillStartDate !==
      (s.price_backfill_default_start_date ?? oneYearAgoIso()) ||
    // 回补模式：与 watch 回填同口径（空值兜底 legacy）
    settingsForm.priceBackfillMode !==
      (s.price_backfill_mode || PRICE_BACKFILL_MODE_LEGACY) ||
    // 交易日历刷新起始日期：服务端 null → 空串，与 watch 回填口径一致
    settingsForm.tradeCalendarStartDate !== (s.trade_calendar_start_date ?? '')
  );
});

/** 保存股息率设置（百分数 → 小数比率） */
function handleSaveSettings(): void {
  const err = validateSettings();
  if (err) {
    settingsFormError.value = err;
    return;
  }
  settingsFormError.value = '';
  const q = quotaToValue(settingsForm.priceBackfillQuota);
  const payload: UpdateDividendYieldSettingsDto = {
    green_threshold: percentToRatio(settingsForm.greenPercent).ratio,
    red_threshold: percentToRatio(settingsForm.redPercent).ratio,
    dividend_report_source_interface_id: toInterfaceIdOrNull(
      settingsForm.dividendReportSourceInterfaceId,
    ),
    dividend_detail_source_interface_id: toInterfaceIdOrNull(
      settingsForm.dividendDetailSourceInterfaceId,
    ),
    price_source_interface_id: toInterfaceIdOrNull(
      settingsForm.priceSourceInterfaceId,
    ),
    announcement_source_interface_id: toInterfaceIdOrNull(
      settingsForm.announcementSourceInterfaceId,
    ),
    price_backfill_source_interface_id: toInterfaceIdOrNull(
      settingsForm.priceBackfillSourceInterfaceId,
    ),
    // 每日回补额度：空串 → null（用后端默认）；合法整数直接传
    price_backfill_quota: q.value,
    // 回补起始日期配置默认值：与在途标记解耦，随设置保存；空串 → null（用既有值）
    price_backfill_default_start_date: settingsForm.priceBackfillStartDate
      ? settingsForm.priceBackfillStartDate
      : null,
    // 回补模式：'legacy' | 'gap'，后端有值域校验（越界 400）；下拉只给两项，无需前端再校验
    price_backfill_mode: settingsForm.priceBackfillMode,
    // 交易日历刷新起始日期：空串 → null（后端视为「不改」）
    trade_calendar_start_date: settingsForm.tradeCalendarStartDate || null,
  };
  settingsMutation.mutate(payload);
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">股息率</CardTitle>
      <CardDescription>
        股息率榜单的标色阈值与数据源接口配置；标色按 A 股语义：≥ 绿色阈值显示红色、≤ 红色阈值显示绿色（§10.2）
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-6">
      <div v-if="settingsLoading" class="space-y-3">
        <Skeleton v-for="i in 4" :key="i" class="h-10 w-full" />
      </div>
      <template v-else>
        <!-- 股息率阈值（百分数输入，提交转小数） -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="dy-green">绿色阈值（股息率 ≥ 显示红色）</Label>
            <div class="flex items-center gap-2">
              <Input
                id="dy-green"
                v-model="settingsForm.greenPercent"
                type="number"
                min="0"
                max="100"
                step="0.5"
                placeholder="如 5（即 5%）"
              />
              <span class="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div class="space-y-2">
            <Label for="dy-red">红色阈值（股息率 ≤ 显示绿色）</Label>
            <div class="flex items-center gap-2">
              <Input
                id="dy-red"
                v-model="settingsForm.redPercent"
                type="number"
                min="0"
                max="100"
                step="0.5"
                placeholder="如 3（即 3%）"
              />
              <span class="text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          阈值以百分数输入（5 = 5%）；校验规则：0 &lt; 红色 &lt; 绿色 ≤ 100%
        </p>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <!-- 股息主源 -->
          <div class="space-y-2">
          <Label for="dy-report-source">股息主数据源接口（按报告期全量）</Label>
          <Select v-model="settingsForm.dividendReportSourceInterfaceId">
            <SelectTrigger id="dy-report-source" class="w-full">
              <SelectValue placeholder="选择股息主数据源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
              <SelectItem
                v-for="itf in dividendSourceOptions"
                :key="itf.id"
                :value="itf.id"
              >
                {{ itf.name }}（{{ providerNameById.get(itf.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- 股息补充源 -->
        <div class="space-y-2">
          <Label for="dy-detail-source">股息明细源接口（按证券逐只）</Label>
          <Select v-model="settingsForm.dividendDetailSourceInterfaceId">
            <SelectTrigger id="dy-detail-source" class="w-full">
              <SelectValue placeholder="选择股息明细源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
              <SelectItem
                v-for="itf in dividendDetailOptions"
                :key="itf.id"
                :value="itf.id"
              >
                {{ itf.name }}（{{ providerNameById.get(itf.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- 行情源 -->
        <div class="space-y-2">
          <Label for="dy-price-source">行情源接口（收盘价）</Label>
          <Select v-model="settingsForm.priceSourceInterfaceId">
            <SelectTrigger id="dy-price-source" class="w-full">
              <SelectValue placeholder="选择行情源接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
              <SelectItem
                v-for="itf in priceSourceOptions"
                :key="itf.id"
                :value="itf.id"
              >
                {{ itf.name }}（{{ providerNameById.get(itf.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- 公司公告源 -->
        <div class="space-y-2">
          <Label for="dy-announcement-source">公司公告接口</Label>
          <Select v-model="settingsForm.announcementSourceInterfaceId">
            <SelectTrigger id="dy-announcement-source" class="w-full">
              <SelectValue placeholder="选择公司公告接口" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
              <SelectItem
                v-for="itf in announcementSourceOptions"
                :key="itf.id"
                :value="itf.id"
              >
                {{ itf.name }}（{{ providerNameById.get(itf.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectContent>
          </Select>
          </div>
        </div>

        <!-- 初始化（冷启动 / 数据修复用手工动作）：整块抽至 GlobalSettingsDividendInitSection -->
        <GlobalSettingsDividendInitSection
          :interface-options="priceBackfillInterfaceOptions"
          v-model:interface-id="settingsForm.priceBackfillSourceInterfaceId"
          v-model:quota="settingsForm.priceBackfillQuota"
          v-model:default-start-date="settingsForm.priceBackfillStartDate"
          v-model:mode="settingsForm.priceBackfillMode"
          v-model:trade-calendar-start-date="settingsForm.tradeCalendarStartDate"
          :in-flight-start-date="dividendSettings?.price_backfill_start_date ?? null"
          :used-today="dividendSettings?.price_backfill_used_today ?? 0"
          :last-error="dividendSettings?.price_backfill_last_error ?? null"
        />

        <p v-if="settingsFormError" class="text-xs text-red-500">
          {{ settingsFormError }}
        </p>

        <!-- 保存 -->
        <div class="flex items-center gap-3 pt-2">
          <Button
            :disabled="!settingsHasChanges || settingsPending"
            @click="handleSaveSettings"
          >
            <Loader2
              v-if="settingsPending"
              class="mr-2 h-4 w-4 animate-spin"
            />
            保存股息率设置
          </Button>
          <span v-if="settingsError" class="text-xs text-red-500">
            保存失败，请重试
          </span>
          <span
            v-if="settingsHasChanges && !settingsPending"
            class="text-xs text-muted-foreground"
          >
            有未保存的更改
          </span>
        </div>
      </template>
    </CardContent>
  </Card>
</template>
