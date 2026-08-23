/**
 * modules/overview/__tests__/metric-card.test.ts — 统一指标卡组件测试
 *
 * 覆盖（B4 批次验收：统计卡渲染，StatCard 已收敛为 MetricCard）：
 * 1. 基础渲染：标签 + 数值 + tabular-nums 等宽数字类；中性态无涨跌箭头
 * 2. 涨跌方向：trend=up 渲染上箭标且着色 text-up；trend=down 下箭标 text-down
 * 3. change 与 description 组合：两段文案以「·」分隔同时渲染
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MetricCard from '@/components/common/MetricCard.vue';

describe('MetricCard — 统一指标卡', () => {
  it('基础渲染：标签、数值与 tabular-nums 类；无 trend 时不渲染箭头', () => {
    const wrapper = mount(MetricCard, {
      props: { label: '当前总资产', value: '¥205,000.00' },
    });

    expect(wrapper.text()).toContain('当前总资产');
    expect(wrapper.text()).toContain('¥205,000.00');
    // 数值区固定等宽数字类（视觉对齐 React 版 tabular-nums 要求）
    expect(wrapper.find('.tabular-nums').exists()).toBe(true);
    // 中性态不渲染涨跌箭头
    expect(wrapper.findAll('svg')).toHaveLength(0);
  });

  it('涨跌方向：trend=up 上箭标着色 text-up，trend=down 下箭标着色 text-down', () => {
    const up = mount(MetricCard, {
      props: { label: '累计收益率', value: '12.35%', trend: 'up' },
    });
    expect(up.find('.text-up').exists()).toBe(true);
    expect(up.findAll('svg')).toHaveLength(1);

    const down = mount(MetricCard, {
      props: { label: '当年收益率', value: '-3.21%', trend: 'down' },
    });
    expect(down.find('.text-down').exists()).toBe(true);
    expect(down.find('.text-up').exists()).toBe(false);
  });

  it('change 与 description 同时提供时以「·」分隔渲染', () => {
    const wrapper = mount(MetricCard, {
      props: {
        label: '累计净值',
        value: '1.1235',
        change: '+2.1pp',
        trend: 'up',
        description: '单位净值',
      },
    });

    const line = wrapper.find('.mt-1').text();
    expect(line).toContain('+2.1pp');
    expect(line).toContain('·');
    expect(line).toContain('单位净值');
    // 仅 change 无 description 时不渲染分隔符
    const onlyChange = mount(MetricCard, {
      props: { label: '累计净值', value: '1.1235', change: '+2.1pp' },
    });
    expect(onlyChange.find('.mt-1').text()).not.toContain('·');
  });
});
