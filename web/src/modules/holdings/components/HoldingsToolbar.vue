<script setup lang="ts">
/**
 * modules/holdings/components/HoldingsToolbar.vue — 持仓页统一筛选器（I-05 · 持仓日期卡片重新设计）
 *
 * 平移自 React 版 web/src/features/holdings/holdings-toolbar.tsx。
 *
 * 持仓 / 买卖明细 / 分红费用 三个板块共享同一个筛选器，位于页面顶部。
 * 承载容器 = 原「持仓日期卡片」升级（rounded-md border p-3 体系）。
 *
 * 筛选维度（架构 §4.4.1）：
 * 1. 快捷范围下拉（7 项 QUICK_RANGE_OPTIONS）+ 自定义起止（DateRangeQuickPicker 口径）—— 买卖明细/分红费用
 * 2. 持仓日期 as-of 单点（label 内化为「持仓日期（as-of）」）—— 持仓板块
 * 3. 证券多选下拉（含已选计数徽标）—— 三板块
 * 4. 场景下拉（买入/卖出/全部）—— 买卖明细→side、分红费用→scenario（持仓不适用置灰）
 * 5. 持仓专属折叠区：类型多选 + 显示已清仓开关（可折叠避免卡片过重）
 *
 * 纯受控组件：状态由 useUrlState 持有（URL query 持久化），本组件只负责渲染 + change 回调。
 * 零新依赖：多选下拉沿用自绘 checkbox 面板范式。
 */
import { computed, ref } from 'vue';
import { Check, ChevronDown, Filter } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';
import { resolveQuickRange } from '@/modules/query/quick-range';
import { todayInAppTzIso } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { SecurityType } from '@/lib/types';
import { FeeScenario } from '@/api/types';
import type { Security } from '@/api/types';
import { HOLDINGS_TYPE_OPTIONS } from '../query-params';
import type { HoldingsFilterState } from '../query-params';

const props = defineProps<{
  /** 统一筛选器状态（useUrlState 持有） */
  value: HoldingsFilterState;
  /** 持仓日期 as-of 下限（首个交易日；无交易 = 组合创建日） */
  minDate: string;
  /** 「全部」快捷项起始日（Portfolio.baseDate） */
  allRangeStart?: string | null;
  /** 标的多选数据源 */
  securities: Security[];
  class?: string;
}>();

const emit = defineEmits<{
  /** 状态增量补丁（由页面写入 useUrlState） */
  change: [patch: Partial<HoldingsFilterState>];
}>();

const secOpen = ref(false);
const secQuery = ref('');
const typesOpen = ref(false);
const holdingsOpen = ref(false);
const maxDate = todayInAppTzIso();

// 证券筛选：文本框模糊匹配（code/name，覆盖所有标的类型，I-05 升级）
const q = computed(() => secQuery.value.trim().toLowerCase());
const filteredSecurities = computed(() =>
  q.value
    ? props.securities.filter(
        (s) =>
          s.name.toLowerCase().includes(q.value) ||
          s.code.toLowerCase().includes(q.value),
      )
    : props.securities,
);

// 起止日期回显：range=custom 用 from/to；否则按快捷项解析（含「全部」以 baseDate 为起点）
const displayRange = computed(() =>
  props.value.range === 'custom'
    ? { startDate: props.value.from, endDate: props.value.to }
    : resolveQuickRange(props.value.range, {
        allRangeStart: props.allRangeStart ?? undefined,
      }),
);

/** 证券搜索输入：同步过滤词并展开面板（对齐 React 版 onChange 里 setSecOpen(true)） */
function onSecQueryInput(v: string | number): void {
  secQuery.value = String(v);
  secOpen.value = true;
}

function toggleSecurity(id: string): void {
  const next = props.value.sec.includes(id)
    ? props.value.sec.filter((s) => s !== id)
    : [...props.value.sec, id];
  emit('change', { sec: next });
}

function toggleType(t: SecurityType): void {
  const next = props.value.types.includes(t)
    ? props.value.types.filter((x) => x !== t)
    : [...props.value.types, t];
  emit('change', { types: next });
}

/**
 * 证券面板延迟关闭（120ms）：给面板项 click 留出触发窗口，
 * 面板项 mousedown.prevent 已保持输入框焦点，与 React 版 onBlur 行为一致。
 */
function scheduleCloseSecPanel(): void {
  window.setTimeout(() => {
    secOpen.value = false;
  }, 120);
}

/** 快捷范围 / 自定义起止变更：快捷项写 range 并清空 from/to；手动改日期写 custom */
function handleRangeChange(r: {
  startDate: string;
  endDate: string;
  quick?: string;
}): void {
  if (r.quick) {
    emit('change', {
      range: r.quick as HoldingsFilterState['range'],
      from: '',
      to: '',
    });
  } else {
    emit('change', { range: 'custom', from: r.startDate, to: r.endDate });
  }
}
</script>

<template>
  <div
    :class="cn('rounded-md border border-border p-3', props.class)"
    data-testid="holdings-unified-filter"
  >
    <!-- 标题 + 口径提示（I-05 §6.2.3/6.2.4） -->
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="flex items-center gap-1.5 text-sm font-semibold">
        <Filter class="h-3.5 w-3.5 text-muted-foreground" />
        统一筛选器
      </p>
      <p class="text-xs text-muted-foreground">
        持仓板块以持仓日期为准，买卖明细 / 分红费用以日期范围为准
      </p>
    </div>

    <div class="flex flex-wrap items-end gap-3">
      <!-- ① 快捷范围 + 自定义起止（I-05/I-06：必须含 7 项快捷范围） -->
      <DateRangeQuickPicker
        :quick="value.range"
        :start-date="displayRange.startDate"
        :end-date="displayRange.endDate"
        :all-range-start="allRangeStart"
        @change="handleRangeChange"
      />

      <!-- ② 持仓日期（as-of）单点（HOLD-B-P0-11 能力保留：默认今日、范围校验） -->
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">持仓日期（as-of）</Label>
        <Input
          type="date"
          :model-value="value.date"
          :min="minDate"
          :max="maxDate"
          class="w-[160px]"
          @update:model-value="(v) => emit('change', { date: String(v) })"
        />
      </div>

      <!--
        ③ 证券：文本框模糊匹配（code/name，覆盖全部标的类型；多选保持 sec=ID 契约）。
        面板开合：容器 focusin 展开输入获焦；focusout（blur 不冒泡，focusout 冒泡）
        延迟 120ms 关面板，面板项 mousedown.prevent 保持输入框焦点，
        与 React 版 onFocus/onBlur 行为一致。
      -->
      <div
        class="relative space-y-1.5"
        @focusin="secOpen = true"
        @focusout="scheduleCloseSecPanel"
      >
        <Label class="text-xs text-muted-foreground">证券</Label>
        <SearchInput
          :model-value="secQuery"
          type="text"
          :placeholder="
            value.sec.length === 0 ? '搜索代码或名称' : `已选 ${value.sec.length} 项`
          "
          class="w-[180px]"
          @update:model-value="onSecQueryInput"
          @clear="secQuery = ''"
        />
        <div
          v-if="secOpen"
          class="absolute z-20 mt-1 max-h-60 w-[240px] overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <p
            v-if="filteredSecurities.length === 0"
            class="px-2 py-2 text-xs text-muted-foreground"
          >
            无匹配标的
          </p>
          <label
            v-for="sec in filteredSecurities"
            :key="sec.id"
            class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
            @mousedown.prevent
          >
            <input
              type="checkbox"
              :checked="value.sec.includes(sec.id)"
              class="h-3.5 w-3.5 accent-primary"
              @change="toggleSecurity(sec.id)"
            />
            <span class="flex-1 truncate">
              {{ sec.name }}
              <span class="ml-1 text-xs text-muted-foreground">{{ sec.code }}</span>
            </span>
            <Check
              v-if="value.sec.includes(sec.id)"
              class="h-3.5 w-3.5 text-primary"
            />
          </label>
        </div>
      </div>

      <!-- ④ 场景下拉（买入/卖出/全部；持仓板块不适用，I-05 §6.2.2） -->
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">场景</Label>
        <Select
          :model-value="value.scenario"
          @update:model-value="
            (v) => emit('change', { scenario: v as HoldingsFilterState['scenario'] })
          "
        >
          <SelectTrigger class="w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem :value="FeeScenario.BUY">买入</SelectItem>
            <SelectItem :value="FeeScenario.SELL">卖出</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <!-- ⑤ 持仓专属折叠区：类型多选 + 显示已清仓 -->
      <div class="space-y-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="h-9 px-2 text-xs text-muted-foreground"
          :aria-expanded="holdingsOpen"
          @click="holdingsOpen = !holdingsOpen"
        >
          {{ holdingsOpen ? '收起' : '展开' }}持仓选项
          <ChevronDown
            :class="cn(
              'h-3.5 w-3.5 transition-transform',
              holdingsOpen && 'rotate-180',
            )"
          />
        </Button>
        <div
          v-if="holdingsOpen"
          class="flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/20 p-2"
        >
          <div class="relative space-y-1.5">
            <Label class="text-xs text-muted-foreground">类型</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="w-[140px] justify-between"
              :aria-expanded="typesOpen"
              @click="typesOpen = !typesOpen"
            >
              <span>
                {{
                  value.types.length === 0
                    ? '全部类型'
                    : `已选 ${value.types.length} 项`
                }}
              </span>
              <ChevronDown class="h-3.5 w-3.5 opacity-60" />
            </Button>
            <div
              v-if="typesOpen"
              class="absolute z-20 mt-1 w-[180px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
            >
              <label
                v-for="opt in HOLDINGS_TYPE_OPTIONS"
                :key="opt.value"
                class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  :checked="value.types.includes(opt.value)"
                  class="h-3.5 w-3.5 accent-primary"
                  @change="toggleType(opt.value)"
                />
                <span class="flex-1">{{ opt.label }}</span>
                <Check
                  v-if="value.types.includes(opt.value)"
                  class="h-3.5 w-3.5 text-primary"
                />
              </label>
            </div>
          </div>

          <div class="flex items-center gap-2 pb-1.5">
            <Switch
              id="holdings-include-closed"
              :model-value="value.closed"
              @update:model-value="(v) => emit('change', { closed: Boolean(v) })"
            />
            <Label for="holdings-include-closed" class="cursor-pointer text-sm">
              显示已清仓
            </Label>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
