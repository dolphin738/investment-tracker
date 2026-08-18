<script setup lang="ts">
/**
 * components/charts/BaseChart.vue — ECharts 基础封装（vue-echarts）
 *
 * 全站图表统一经本组件渲染：
 * - 按需注册 echarts 模块（line / bar / heatmap + 常用组件），控制包体
 * - notMerge 默认开启：整体替换 option，避免旧 series 残留
 *   （切换 metric 时旧曲线不清除的「显示全部曲线」问题）
 * - autoresize：容器尺寸变化时自动重绘，等价 echarts-for-react 行为
 */

import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';

// 按需注册（模块级仅执行一次）
use([
  CanvasRenderer,
  LineChart,
  BarChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  VisualMapComponent,
  ToolboxComponent,
]);

const props = withDefaults(
  defineProps<{
    /** ECharts option（由业务组件的纯函数生成） */
    option: EChartsOption;
    /** 画布高度（px） */
    height?: number;
    /** 是否整体替换 option（默认 true，避免旧 series 残留） */
    notMerge?: boolean;
  }>(),
  { height: 260, notMerge: true },
);
</script>

<template>
  <VChart
    :option="props.option"
    :not-merge="props.notMerge"
    autoresize
    :style="{ height: `${props.height}px`, width: '100%' }"
  />
</template>
