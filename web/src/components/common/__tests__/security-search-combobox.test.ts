/**
 * components/common/__tests__/security-search-combobox.test.ts — 证券搜索选择框回归契约
 *
 * 守护（审查 M-1 重构回归）：交互骨架下沉 ComboboxShell 后，远程搜索数据层契约不变——
 * 250ms 防抖触发 listSecurityMasters、候选渲染、选中回调 onSelect/emit('select')
 * 双路径、清叉 onClear/emit('clear') 双路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import SecuritySearchCombobox from '../SecuritySearchCombobox.vue';
import type { SecurityMaster } from '@/api/security-master.api';

const fixtures = vi.hoisted(() => ({
  calls: [] as string[],
  masters: [
    { id: 's-1', code: '600519', name: '贵州茅台', exchange: 'SH', assetClass: 'STOCK' },
    { id: 's-2', code: '000002', name: '万科A', exchange: 'SZ', assetClass: 'STOCK' },
  ] as SecurityMaster[],
}));

vi.mock('@/api/security-master.api', () => ({
  listSecurityMasters: vi.fn(async (args: { q: string }) => {
    fixtures.calls.push(args.q);
    return { items: fixtures.masters, total: fixtures.masters.length };
  }),
}));

function mountCombo() {
  const onSelect = vi.fn();
  const onClear = vi.fn();
  const wrapper = mount(SecuritySearchCombobox, {
    props: { id: 'cmb', onSelect, onClear, value: '' },
    global: {
      plugins: [
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({
              defaultOptions: { queries: { retry: false } },
            }),
          },
        ],
      ],
    },
  });
  return { wrapper, onSelect, onClear };
}

describe('SecuritySearchCombobox（外壳下沉后数据层契约）', () => {
  beforeEach(() => {
    fixtures.calls = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('键入防抖 250ms 后触发远程搜索并渲染候选', async () => {
    const { wrapper } = mountCombo();
    await wrapper.find('input').setValue('茅台');
    // 防抖窗口内未请求
    expect(fixtures.calls.length).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    await flushPromises();
    expect(fixtures.calls).toEqual(['茅台']);
    expect(wrapper.text()).toContain('贵州茅台');
    expect(wrapper.text()).toContain('万科A');
  });

  it('点击候选：onSelect 与 emit select 双路径触发', async () => {
    const { wrapper, onSelect } = mountCombo();
    await wrapper.find('input').setValue('茅台');
    await new Promise((r) => setTimeout(r, 300));
    await flushPromises();
    await wrapper.find('[data-combobox-candidate]').trigger('click');
    await flushPromises();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].code).toBe('600519');
    expect(wrapper.emitted('select')).toHaveLength(1);
  });

  it('清除叉：onClear 与 emit clear 双路径触发', async () => {
    const { wrapper, onClear } = mountCombo();
    await wrapper.find('input').setValue('茅台');
    await flushPromises();
    await wrapper.find('[aria-label="清除"]').trigger('click');
    await flushPromises();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('clear')).toHaveLength(1);
  });
});
