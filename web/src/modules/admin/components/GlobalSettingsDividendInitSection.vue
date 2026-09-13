<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendInitSection.vue — 全局设置「股息率」TAB 的「初始化」功能块
 *
 * 哑组件（presentational）：不取数、不管保存，仅接 props 渲染、用 emit 回传两个值。
 * 父组件继续持有全部状态（settingsForm）与保存逻辑。
 *
 * 承载内容：
 * - 「初始化」标题与说明
 * - 「历史行情回补接口」下拉（参与父组件 settings 保存，候选由父组件拼好 label 传入）
 * - 复用现有 GlobalSettingsDividendInitBlock（内部含额度输入 / 回补起始日期 / 三按钮 / 弹窗）
 */
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SELECT_EMPTY_VALUE } from '@/lib/constants';
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
  /** 在途回补任务目标起始日（只读，服务端管理）；非空 = 有在途任务，禁用起点输入与触发 */
  inFlightStartDate: string | null;
  /** 当日已用回补额度（只），直接透传给 InitBlock（用于剩余额度与「今日已用 X/N」） */
  usedToday: number;
  /** 最近一次回补失败原因（熔断/接口不可达）；非空 = 最近一次在途回补以失败告终，红字展示 */
  lastError: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:interfaceId', v: string): void;
  (e: 'update:quota', v: string): void;
  (e: 'update:defaultStartDate', v: string): void;
}>();
</script>

<template>
  <div class="space-y-4 border-t pt-4">
    <div class="space-y-1">
      <h3 class="text-sm font-medium">初始化</h3>
      <p class="text-xs text-muted-foreground">
        冷启动或数据修复时使用的手工动作；触发后任务在后台执行，进度见应用日志。
      </p>
    </div>

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

    <GlobalSettingsDividendInitBlock
      :backfill-interface-id="interfaceId"
      :price-backfill-quota="quota"
      :price-backfill-default-start-date="defaultStartDate"
      :price-backfill-in-flight-date="inFlightStartDate"
      :price-backfill-used-today="usedToday"
      :price-backfill-last-error="lastError"
      @update:price-backfill-quota="(v) => emit('update:quota', v)"
      @update:price-backfill-default-start-date="(v) => emit('update:defaultStartDate', v)"
    />
  </div>
</template>
