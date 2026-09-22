/**
 * modules/admin/__tests__/pending-dividend-assign-dialog.test.ts
 *
 * 待划分分红「指定报告期」弹窗（批次 D 收口项）行为回归：
 * 两个原生 <select>（报告期类型 / 季度）已统一为全站 reka-ui Select，本文件验证
 * 「组件形态变了、交互语义不变」——即跨字段联动、季度禁用态、采纳建议三条关键行为
 * 与改造前原生 select 版本完全等价。
 *
 * 测试手法：照全站既有惯例——
 * - reka-ui Select 以轻量替身渲染（原生 <select>/<option>），并把 SelectTrigger 上的
 *   id / disabled 透传到替身 <select>，使 `#pd-period-type` / `#pd-report-quarter` 可作为
 *   稳定锚点、禁用态可断言；
 * - reka-ui Dialog 走真实实现（内容经自研 Portal 渲染到 document.body），与
 *   quote-interface-dialog-prefill.test.ts 同手法。
 *
 * 说明：原 pending-dividends-page.test.ts 以整组件替身替换此弹窗，故从未覆盖下列内部行为；
 * 本文件为新增覆盖（不影响既有用例数量），断言语义未弱化、且更强。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { components } from '@/types/api';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

type PendingDividendOut = components['schemas']['PendingDividendOut'];

// reka-ui Select 原生替身：Select → <select>，SelectItem → <option>。
// 关键：把子节点 SelectTrigger 上的 id / disabled 透传到替身 <select>，使测试可按
// #pd-period-type / #pd-report-quarter 定位，并断言季度禁用态。
vi.mock('@/components/ui/select', async () => {
  const { defineComponent, h } = await import('vue');
  const Select = defineComponent({
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      return () => {
        const children = slots.default?.() ?? [];
        const trigger = children
          .map((v) => (v && typeof v === 'object' ? (v as { props?: Record<string, unknown> }).props : null))
          .find((p) => p && typeof p === 'object' && 'id' in p);
        const triggerId = (trigger?.id as string | undefined) ?? undefined;
        const disabled = Boolean(trigger?.disabled ?? false);
        return h(
          'select',
          {
            id: triggerId,
            value: props.modelValue ?? '',
            disabled,
            'data-testid': 'select',
            class: 'select-stub',
            onChange: (e: Event) =>
              emit('update:modelValue', (e.target as HTMLSelectElement).value),
          },
          [h('option', { key: '__ph', value: '' }, ''), children],
        );
      };
    },
  });
  const SelectItem = defineComponent({
    props: { value: { type: String, required: true }, disabled: { type: Boolean, default: false } },
    setup(props, { slots }) {
      return () =>
        h(
          'option',
          { value: props.value, disabled: props.disabled || undefined },
          slots.default?.(),
        );
    },
  });
  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.();
    },
  });
  const renderNothing = defineComponent({
    setup() {
      return () => null;
    },
  });
  return {
    Select,
    SelectItem,
    SelectTrigger: renderNothing,
    SelectValue: renderNothing,
    SelectContent: passthrough,
    SelectGroup: passthrough,
    SelectLabel: renderNothing,
  };
});

import PendingDividendAssignDialog from '../components/PendingDividendAssignDialog.vue';

let wrapper: VueWrapper | null = null;

function row(over: Partial<PendingDividendOut>): PendingDividendOut {
  return {
    id: 'p1',
    masterId: 'm1',
    code: '600001',
    name: '证券A',
    exchange: 'SH',
    dividendLabel: '年度分红',
    cashPerShare: '1.000000',
    bonusShareRatio: null,
    convertRatio: null,
    recordDate: null,
    exDividendDate: '2024-11-26',
    payDate: null,
    announcementDate: '2025-03-15',
    reportPeriodRaw: '年度分红',
    status: 'PENDING',
    resolvedPeriodType: null,
    resolvedReportYear: null,
    resolvedReportQuarter: null,
    createdAt: '2024-12-01T00:00:00Z',
    resolvedAt: null,
    ...over,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await nextTick();
}

async function mountDialog(over: Partial<PendingDividendOut> = {}): Promise<VueWrapper> {
  const w = mount(PendingDividendAssignDialog, {
    attachTo: document.body,
    props: {
      open: false,
      row: row(over),
      retentionYears: 5,
      pending: false,
    },
  });
  await w.setProps({ open: true });
  await settle();
  return w;
}

/** 按锚点取弹层内的下拉（reka-ui Dialog 把内容 Portal 到 body） */
function selectById(id: string): HTMLSelectElement {
  const el = document.body.querySelector(`#${id}`) as HTMLSelectElement | null;
  if (!el) throw new Error(`未在 document.body 找到 #${id}`);
  return el;
}

/** 按精确文案取弹层内按钮 */
function buttonByText(text: string): HTMLButtonElement {
  const btns = Array.from(document.body.querySelectorAll('button')) as HTMLButtonElement[];
  const target = btns.find((b) => (b.textContent ?? '').trim() === text);
  if (!target) throw new Error(`未找到文案为「${text}」的按钮`);
  return target;
}

function setSelectValue(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  installJsdomPolyfills();
  vi.clearAllMocks();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('PendingDividendAssignDialog — reka-ui Select 行为等价', () => {
  it('① 报告期类型切换 → 季度跨字段联动（选 ANNUAL 季度落 4）', async () => {
    wrapper = await mountDialog();
    const typeSel = selectById('pd-period-type');
    const quarterSel = selectById('pd-report-quarter');

    // 初始：由「年度分红」推断为 ANNUAL，季度首项合法格 = 4
    expect(typeSel.value).toBe('ANNUAL');
    expect(quarterSel.value).toBe('4');

    // 切到 QUARTERLY → 季度回落首项合法格 1，且未整体禁用
    setSelectValue(typeSel, 'QUARTERLY');
    await settle();
    expect(quarterSel.value).toBe('1');
    expect(quarterSel.disabled).toBe(false);

    // 切到 ANNUAL → 季度联动为 4 且整体禁用
    setSelectValue(typeSel, 'ANNUAL');
    await settle();
    expect(quarterSel.value).toBe('4');
    expect(quarterSel.disabled).toBe(true);
  });

  it('② 季度下拉禁用态：单格类型（ANNUAL/INTERIM）禁用 Trigger，QUARTERLY 保留非法项禁用', async () => {
    wrapper = await mountDialog();
    const typeSel = selectById('pd-period-type');
    const quarterSel = selectById('pd-report-quarter');

    // ANNUAL：整体禁用，且值被置为唯一合法格 4
    expect(quarterSel.disabled).toBe(true);
    expect(quarterSel.value).toBe('4');

    // 切 INTERIM → 同样单格，禁用且值为 2
    setSelectValue(typeSel, 'INTERIM');
    await settle();
    expect(quarterSel.disabled).toBe(true);
    expect(quarterSel.value).toBe('2');

    // 切 QUARTERLY：整体不禁用，但非法季度（Q2/Q4）单项仍禁用
    setSelectValue(typeSel, 'QUARTERLY');
    await settle();
    expect(quarterSel.disabled).toBe(false);
    const opts = Array.from(quarterSel.querySelectorAll('option'));
    const byValue = (v: string) => opts.find((o) => o.getAttribute('value') === v)!;
    // 合法格 Q1/Q3 可用，非法格 Q2/Q4 单项禁用（与原生 select 的 :disabled 等价）
    expect(byValue('1').hasAttribute('disabled')).toBe(false);
    expect(byValue('3').hasAttribute('disabled')).toBe(false);
    expect(byValue('2').hasAttribute('disabled')).toBe(true);
    expect(byValue('4').hasAttribute('disabled')).toBe(true);
  });

  it('③ 采纳建议：仅填表单（不提交），且提交 payload 与建议一致', async () => {
    // 「年度分红」+ 公告日 2025-03-15 → 主候选 ANNUAL / 2024 / Q4
    wrapper = await mountDialog();

    // 打开时年份为空（强制显式决策），采纳前未提交
    const yearInput = document.body.querySelector('#pd-report-year') as HTMLInputElement;
    expect(yearInput.value).toBe('');
    expect(wrapper.emitted('submit')).toBeUndefined();

    buttonByText('采纳建议').click();
    await settle();

    // 采纳后年份被填（2024）、季度 4、类型 ANNUAL；按钮转「已采纳（可修改）」
    expect(yearInput.value).toBe('2024');
    expect(selectById('pd-report-quarter').value).toBe('4');
    expect(selectById('pd-period-type').value).toBe('ANNUAL');
    expect(buttonByText('已采纳（可修改）')).toBeTruthy();
    // 采纳只是填表，未触发提交
    expect(wrapper.emitted('submit')).toBeUndefined();

    // 提交 → payload 与建议一致
    buttonByText('提交').click();
    await settle();
    const submit = wrapper.emitted('submit');
    expect(submit).toBeTruthy();
    expect(submit![0][0]).toEqual({
      reportYear: 2024,
      reportQuarter: 4,
      periodType: 'ANNUAL',
    });
  });

  it('④ 校验失败（年份空）不提交，红字提示', async () => {
    wrapper = await mountDialog();
    // 不采纳、年份留空直接提交
    buttonByText('提交').click();
    await settle();
    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(document.body.textContent).toContain('报告年须为');
  });
});
