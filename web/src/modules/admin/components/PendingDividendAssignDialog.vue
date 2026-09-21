<script setup lang="ts">
/**
 * modules/admin/components/PendingDividendAssignDialog.vue — 待划分分红「指定报告期」弹窗
 *
 * 职责（设计 §5.3.6 / review §5.3.6）：
 * - 打开时**表单保持空**（强制显式决策），展示源站原文摘要 + 建议值（主候选 / 备选）。
 * - 「采纳建议」→ **只填表单**、按钮变「已采纳（可修改）」、**不提交**；无候选则不渲染该按钮。
 * - 「提交」**始终可点**，校验失败以红字提示（不做禁用式隐藏，避免用户困惑）。
 * - 跨字段联动用「禁用」优于「报错」：选 ANNUAL → 季度自动置 4 且置灰；INTERIM → 置 2 且置灰。
 * - 留存窗外：建议值旁加 Badge「留存窗外」并说明「转正后可能被留存清理删除」。
 *
 * 弹窗自身不做请求：表单值经 submit 上抛，由页面执行 useAssignPendingDividend mutation，
 * 以便统一处理 conflict / toast / 刷新。
 */
import { computed, ref, watch } from 'vue';
import type { components } from '@/types/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  MIN_REPORT_YEAR,
  PERIOD_TYPE_LABELS,
  inferPeriodType,
  isOutsideRetention,
  isValidQuarter,
  legalQuarters,
  maxReportYear,
  suggestReportPeriod,
  type PendingPeriodType,
} from '@/modules/dividend-yield/lib/suggest-report-period';

type PendingDividendOut = components['schemas']['PendingDividendOut'];

const props = defineProps<{
  /** 是否打开 */
  open: boolean;
  /** 当前待划分行（null 表示未选中） */
  row: PendingDividendOut | null;
  /** 留存窗年数（来自 GET /settings 的 dividend_retention_years，未配置回落 5） */
  retentionYears: number;
  /** 提交中（禁用提交按钮） */
  pending: boolean;
}>();

const emit = defineEmits<{
  (
    e: 'submit',
    payload: {
      reportYear: number;
      reportQuarter: number;
      periodType: PendingPeriodType;
    },
  ): void;
  (e: 'update:open', open: boolean): void;
}>();

const currentYear = new Date().getFullYear();
const yearMax = maxReportYear(currentYear);

const PERIOD_TYPES: PendingPeriodType[] = [
  'ANNUAL',
  'INTERIM',
  'QUARTERLY',
  'SPECIAL',
  'OTHER',
];

// ── 表单（打开即清空，强制显式决策） ──
const periodType = ref<PendingPeriodType>('OTHER');
const reportYear = ref<number | null>(null);
const reportQuarter = ref<number>(1);
const adopted = ref(false);
const errorText = ref('');

/** 由原文标签推断的默认类型（未采纳建议时的宽松初值） */
const inferredType = computed<PendingPeriodType>(() =>
  inferPeriodType(props.row?.dividendLabel ?? null),
);

const candidates = computed(() =>
  props.row
    ? suggestReportPeriod({
        dividendLabel: props.row.dividendLabel ?? null,
        announcementDate: props.row.announcementDate ?? null,
        exDividendDate: props.row.exDividendDate ?? null,
      })
    : [],
);
const primary = computed(() => candidates.value[0] ?? null);
const alternate = computed(() => candidates.value[1] ?? null);
const hasCandidate = computed(() => candidates.value.length > 0);

/** 当前类型下的合法季度集合 */
const legal = computed(() => legalQuarters(periodType.value));
/** 单格类型（ANNUAL/INTERIM）→ 季度联动禁用 */
const quarterDisabled = computed(() => legal.value.length === 1);

/** 选中类型的合法季度一栏是否含目标年（用于「留存窗外」Badge 的判定年份） */
const outsideRetention = computed(() => {
  if (reportYear.value === null) return false;
  return isOutsideRetention(reportYear.value, currentYear, props.retentionYears);
});

/** 类型切换：季度回落到该类型首个合法格（联动，不报错） */
function onTypeChange(v: string): void {
  periodType.value = v as PendingPeriodType;
  reportQuarter.value = legalQuarters(periodType.value)[0];
  adopted.value = false;
}

/** 采纳建议：仅填表单，按钮转「已采纳」，不提交 */
function adopt(): void {
  const c = primary.value;
  if (!c) return;
  periodType.value = c.periodType;
  reportYear.value = c.reportYear;
  reportQuarter.value = c.reportQuarter;
  adopted.value = true;
  errorText.value = '';
}

/** 校验（提交前）；通过返回 payload，失败返回 null 并写 errorText */
function validate(): {
  reportYear: number;
  reportQuarter: number;
  periodType: PendingPeriodType;
} | null {
  const y = reportYear.value;
  if (y === null || !Number.isInteger(y) || y < MIN_REPORT_YEAR || y > yearMax) {
    errorText.value = `报告年须为 ${MIN_REPORT_YEAR} ~ ${yearMax} 的整数`;
    return null;
  }
  const q = reportQuarter.value;
  if (!Number.isInteger(q) || q < 1 || q > 4) {
    errorText.value = '季度须为 1 ~ 4';
    return null;
  }
  if (!isValidQuarter(periodType.value, q)) {
    errorText.value = `${PERIOD_TYPE_LABELS[periodType.value]} 的合法季度为 ${legal.value.join('、')}`;
    return null;
  }
  errorText.value = '';
  return { reportYear: y, reportQuarter: q, periodType: periodType.value };
}

function onSubmit(): void {
  const payload = validate();
  if (payload) emit('submit', payload);
}

/** 每次打开：清空表单（强制显式决策），类型取推断值、季度取该类型首格 */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    periodType.value = inferredType.value;
    reportQuarter.value = legalQuarters(periodType.value)[0];
    reportYear.value = null;
    adopted.value = false;
    errorText.value = '';
  },
);
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => emit('update:open', o)">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>指定报告期</DialogTitle>
        <DialogDescription>
          源站「报告时间」不可解析，请人工指定该笔现金分红归属的报告期。
        </DialogDescription>
      </DialogHeader>

      <!-- 原文摘要 -->
      <div class="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono">{{ row?.code || '未知代码' }}</span>
          <span>{{ row?.name || '' }}</span>
          <Badge v-if="row?.dividendLabel" variant="outline">
            {{ row?.dividendLabel }}
          </Badge>
        </div>
        <div class="text-xs text-muted-foreground">
          派息 {{ row?.cashPerShare ?? '—' }} 元/股 ｜
          公告日 {{ row?.announcementDate || '—' }} ｜
          除权日 {{ row?.exDividendDate || '—' }}
        </div>
        <div v-if="row?.reportPeriodRaw" class="text-xs text-muted-foreground">
          源站报告时间原文：{{ row.reportPeriodRaw }}
        </div>
      </div>

      <!-- 建议值 -->
      <div v-if="hasCandidate" class="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">建议报告期</span>
          <Button
            variant="outline"
            size="sm"
            @click="adopt"
          >
            {{ adopted ? '已采纳（可修改）' : '采纳建议' }}
          </Button>
        </div>
        <div class="text-sm">
          主候选：
          <span class="font-medium">
            {{ primary?.reportYear }} 年 Q{{ primary?.reportQuarter }}
            · {{ primary ? PERIOD_TYPE_LABELS[primary.periodType] : '' }}
          </span>
          <Badge
            v-if="primary && isOutsideRetention(primary.reportYear, currentYear, retentionYears)"
            variant="destructive"
            class="ml-2"
          >
            留存窗外
          </Badge>
        </div>
        <div v-if="alternate" class="text-xs text-muted-foreground">
          备选（由除权日推定，粗略）：{{ alternate.reportYear }} 年 Q{{ alternate.reportQuarter }}
        </div>
        <p
          v-if="primary && isOutsideRetention(primary.reportYear, currentYear, retentionYears)"
          class="text-xs text-destructive"
        >
          该报告年落在留存窗外，转正后可能被留存清理删除；若确无归属，建议改点「忽略」。
        </p>
      </div>
      <div v-else class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        无候选，须人工指定报告期。
      </div>

      <!-- 自定义表单 -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="space-y-2">
          <Label for="pd-period-type">报告期类型</Label>
          <select
            id="pd-period-type"
            class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            :value="periodType"
            @change="onTypeChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="t in PERIOD_TYPES" :key="t" :value="t">
              {{ PERIOD_TYPE_LABELS[t] }}
            </option>
          </select>
        </div>
        <div class="space-y-2">
          <Label for="pd-report-year">报告年份</Label>
          <Input
            id="pd-report-year"
            type="number"
            :model-value="reportYear ?? ''"
            :min="MIN_REPORT_YEAR"
            :max="yearMax"
            placeholder="YYYY"
            @update:model-value="(v) => (reportYear = v === '' ? null : Number(v))"
          />
        </div>
        <div class="space-y-2">
          <Label for="pd-report-quarter">季度</Label>
          <select
            id="pd-report-quarter"
            class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
            :value="String(reportQuarter)"
            :disabled="quarterDisabled"
            @change="reportQuarter = Number(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="q in [1, 2, 3, 4]"
              :key="q"
              :value="String(q)"
              :disabled="!legal.includes(q)"
            >
              Q{{ q }}
            </option>
          </select>
        </div>
      </div>

      <p v-if="outsideRetention" class="text-xs text-destructive">
        ⚠️ 当前报告年（{{ reportYear }}）落在留存窗外，转正后可能被留存清理删除。
      </p>
      <p v-if="errorText" class="text-xs text-red-500">{{ errorText }}</p>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">取消</Button>
        <Button :disabled="pending" @click="onSubmit">
          {{ pending ? '提交中…' : '提交' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
