<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendInitSection.vue — 全局设置「股息率」TAB 的「初始化」功能块
 *
 * 哑组件（presentational）：不取数、不管保存，仅接 props 渲染、用 emit 回传值。
 * 父组件继续持有全部状态（settingsForm）与保存逻辑。
 *
 * 布局：五个配置控件排成网格——
 *   行1：历史行情回补接口（证券行情） | 交易日历起始日期
 *   行2：每日回补额度（只/天） | 回补起始日期
 *   行3：回补模式（整行，因说明文字较长）
 * 其后复用 GlobalSettingsDividendInitBlock（内部只保留在途提示、失败原因与触发/取消按钮；
 * 额度与起点的数值仍透传进去，供其「今日已用 X/N」与按钮禁用判断使用）。
 */
import { computed } from 'vue';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  PRICE_BACKFILL_MODE_LEGACY,
  PRICE_BACKFILL_MODE_OPTIONS,
  SELECT_EMPTY_VALUE,
} from '@/lib/constants';
import GlobalSettingsDividendInitBlock from './GlobalSettingsDividendInitBlock.vue';

const props = defineProps<{
  /** 回补接口候选项（label 由父组件拼好，形如「东财-历史行情（akshare）」） */
  interfaceOptions: { id: string; label: string }[];
  /** 当前选中的接口 id（含哨兵值表示「不设置」） */
  interfaceId: string;
  /** 每日回补额度（字符串型，与父组件 settingsForm 口径一致） */
  quota: string;
  /** 回补起始日期配置默认值（可保存；v-model 回传父组件 settingsForm，触发回补以其为起点） */
  defaultStartDate: string;
  /** 历史行情回补模式（'legacy' | 'gap'）；参与父组件 settings 保存，本组件仅渲染选择并回传 */
  mode: string;
  /** 交易日历刷新起始日期（YYYY-MM-DD）；空串 = 未配置（后端默认「去年 1 月 1 日」） */
  tradeCalendarStartDate: string;
  /** 在途回补任务目标起始日（只读，服务端管理）；非空 = 有在途任务，禁用起点输入与触发 */
  inFlightStartDate: string | null;
  /** 当日已用回补额度（只），用于「今日已用 X/N」展示 */
  usedToday: number;
  /** 最近一次回补失败原因（熔断/接口不可达）；非空 = 最近一次在途回补以失败告终，红字展示 */
  lastError: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:interfaceId', v: string): void;
  (e: 'update:quota', v: string): void;
  (e: 'update:defaultStartDate', v: string): void;
  (e: 'update:tradeCalendarStartDate', v: string): void;
  (e: 'update:mode', v: string): void;
}>();

/** 每日额度数值（字符串输入 → 数字，用于「今日已用 X/N」） */
const quotaNum = computed(() => Number(props.quota) || 0);
</script>

<template>
  <div class="space-y-4 border-t pt-4">
    <div class="space-y-1">
      <h3 class="text-sm font-medium">初始化</h3>
      <p class="text-xs text-muted-foreground">
        冷启动或数据修复时使用的手工动作；触发后任务在后台执行，进度见应用日志。
      </p>
    </div>

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <!-- 历史行情回补接口（参与 settings 保存，候选由父组件传入） -->
      <div class="space-y-2">
        <Label for="dy-price-backfill-source">历史行情回补接口（证券行情）</Label>
        <Select
          :model-value="interfaceId"
          @update:model-value="(v) => emit('update:interfaceId', String(v))"
        >
          <SelectTrigger id="dy-price-backfill-source" class="w-full">
            <SelectValue placeholder="选择历史行情回补接口" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="SELECT_EMPTY_VALUE">不设置</SelectItem>
            <SelectItem
              v-for="itf in interfaceOptions"
              :key="itf.id"
              :value="itf.id"
            >
              {{ itf.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <!-- 交易日历起始日期：决定「交易日历刷新」任务的窗口下限（结束上限受数据源限制为当年末） -->
      <div class="space-y-2">
        <Label for="dy-trade-calendar-start">交易日历起始日期</Label>
        <Input
          id="dy-trade-calendar-start"
          :model-value="tradeCalendarStartDate"
          type="date"
          class="w-full"
          @update:model-value="(v) => emit('update:tradeCalendarStartDate', String(v))"
        />
        <p class="text-xs text-muted-foreground">
          交易日历刷新只落该日及之后的交易日；留空 = 去年 1 月 1 日。
          定时任务开启「全量刷新」时会同步清理早于该日的历史；默认增量只补不删。
        </p>
      </div>

      <!-- 每日回补额度（只/天）：参与父组件 settings 保存，本组件仅渲染输入并回传 -->
      <div class="space-y-2">
        <Label for="dy-price-backfill-quota">每日回补额度（只/天）</Label>
        <Input
          id="dy-price-backfill-quota"
          :model-value="quota"
          type="number"
          min="1"
          max="2000"
          @update:model-value="(v) => emit('update:quota', String(v))"
        />
        <p class="text-xs text-muted-foreground">
          每日收盘价抓取后按该额度自动续跑，补完自动停止
        </p>
        <p
          v-if="quotaNum > 0"
          class="text-xs font-medium text-muted-foreground"
        >
          今日已用 {{ usedToday }} / {{ quotaNum }} 只（额度按自然日重置）
        </p>
      </div>

      <!-- 回补起始日期（随设置保存；在途任务存在时禁用，改起点须先取消） -->
      <div class="space-y-2">
        <Label for="dy-backfill-start">回补起始日期</Label>
        <Input
          id="dy-backfill-start"
          :model-value="defaultStartDate"
          type="date"
          class="w-full"
          :disabled="!!inFlightStartDate"
          @update:model-value="(v) => emit('update:defaultStartDate', String(v))"
        />
        <p v-if="inFlightStartDate" class="text-xs text-muted-foreground">
          回补进行中，改起点请先「取消在途回补」
        </p>
        <p v-else class="text-xs text-muted-foreground">
          保存后作为下次「回补行情缺口」的起点（默认一年前）
        </p>
      </div>

      <!-- 回补模式：说明文字较长，整行摆放（sm 起占满两列） -->
      <div class="space-y-2 sm:col-span-2">
        <Label for="dy-backfill-mode">回补模式</Label>
        <Select
          :model-value="mode"
          @update:model-value="(v) => emit('update:mode', String(v))"
        >
          <SelectTrigger id="dy-backfill-mode" class="w-full">
            <SelectValue placeholder="选择回补模式" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="opt in PRICE_BACKFILL_MODE_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">
          「常规」只判断该证券有没有早于起点的日线行，一旦有就整只跳过，<strong>中间的空洞不会补</strong>；
          「严格补洞」按交易日历逐日比对，缺失的交易日会重新抓取（会重复消耗每日额度）。
          切到「严格补洞」前请确认交易日历已刷新——日历未覆盖回补区间时后端会自动回落为「常规」。
          当前模式：{{ mode === PRICE_BACKFILL_MODE_LEGACY ? '常规' : '严格补洞' }}
        </p>
      </div>
    </div>

    <GlobalSettingsDividendInitBlock
      :backfill-interface-id="interfaceId"
      :price-backfill-quota="quota"
      :price-backfill-default-start-date="defaultStartDate"
      :price-backfill-in-flight-date="inFlightStartDate"
      :price-backfill-used-today="usedToday"
      :price-backfill-last-error="lastError"
    />
  </div>
</template>
