<script setup lang="ts">
/**
 * modules/admin/components/GlobalSettingsDividendInitSection.vue — 全局设置页「初始化」TAB 内容
 *
 * 哑组件（presentational）：不取数、不管保存，仅接 props 渲染、用 emit 回传值。
 * 父组件（GlobalSettingsPage）继续持有全部状态（settingsForm）与保存逻辑。
 *
 * 布局：仅保留「交易日历起始日期」一项配置控件（参与父组件 settings 保存），
 * 其余冷启动手工动作（全量重建 / 补齐历史分红（播种））交由 GlobalSettingsDividendInitBlock 承载。
 *
 * 「回补行情缺口」相关配置（历史行情回补接口、每日回补额度、回补起始日期、回补模式、
 * 回补复权方式）已随价格缺口回补功能下线一并移除。
 *
 * 「回补复权方式」的『不复权』服务端值为空串（''），而 reka-ui ``<SelectItem />`` 禁止
 * ``value=""``，故旧 UI 用 ``SELECT_EMPTY_VALUE`` 哨兵表示；该控件移除后哨兵不再需要。
 */
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import GlobalSettingsDividendInitBlock from './GlobalSettingsDividendInitBlock.vue';

const props = defineProps<{
  /** 交易日历刷新起始日期（YYYY-MM-DD）；空串 = 未配置（后端默认「去年 1 月 1 日」） */
  tradeCalendarStartDate: string;
}>();

const emit = defineEmits<{
  (e: 'update:tradeCalendarStartDate', v: string): void;
}>();
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-muted-foreground">
      冷启动或数据修复时使用的手工动作；触发后任务在后台执行，进度见应用日志。
    </p>

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
    </div>

    <GlobalSettingsDividendInitBlock />
  </div>
</template>
