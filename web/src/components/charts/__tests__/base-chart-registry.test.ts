/**
 * components/charts/__tests__/base-chart-registry.test.ts
 *
 * 防回归：ECharts 按需（tree-shaken）构建下，option 里用到的 mark* 组件
 * 必须在 BaseChart.vue 的 use([...]) 中显式注册，否则会被**静默丢弃**
 * （不报错、不渲染）。
 *
 * 事故溯源（2026-09-17）：股息率弹窗双轴曲线的高股息线 markLine
 * 在浏览器中始终不显示，但全量 echarts 的 SSR 渲染却正常——根因正是
 * BaseChart 未注册 MarkLineComponent，markLine 被无声忽略。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** components/charts 目录 */
const CHARTS_DIR = resolve(HERE, '..');

/** option 中的 mark* 键 → 需注册的 echarts 组件导出名 */
const MARKER_TO_COMPONENT: Record<string, string> = {
  markLine: 'MarkLineComponent',
  markPoint: 'MarkPointComponent',
  markArea: 'MarkAreaComponent',
};

describe('BaseChart — ECharts 按需组件注册完整性', () => {
  const baseChartSource = readFileSync(join(CHARTS_DIR, 'BaseChart.vue'), 'utf-8');

  it('已注册 MarkLineComponent（股息率曲线高股息线参考线依赖）', () => {
    expect(baseChartSource).toContain('MarkLineComponent');
  });

  it('任何图表 option builder 用到的 mark* 组件都已在 BaseChart 注册', () => {
    const builders = readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.ts'));
    const missing: string[] = [];
    for (const file of builders) {
      const src = readFileSync(join(CHARTS_DIR, file), 'utf-8');
      for (const [marker, component] of Object.entries(MARKER_TO_COMPONENT)) {
        if (src.includes(`${marker}:`) && !baseChartSource.includes(component)) {
          missing.push(`${file} 使用了 ${marker}，但 BaseChart 未注册 ${component}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
