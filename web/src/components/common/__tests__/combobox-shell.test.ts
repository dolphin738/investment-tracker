/**
 * components/common/__tests__/combobox-shell.test.ts — 通用搜索选择框外壳交互契约
 *
 * 守护（审查 M-1 / L-1 / L-2 收口）：远程/浏览两种展开模式、@search 抛出原文、
 * 键盘导航（↓/↑/Enter/Esc）与 aria-activedescendant、选中后复位、清除叉、
 * loading / error / empty 三态。候选渲染由测试经函数插槽注入（与生产用法一致）。
 */
import { describe, expect, it } from 'vitest';
import { h } from 'vue';
import { mount } from '@vue/test-utils';
import ComboboxShell from '../ComboboxShell.vue';

function mountShell(
  props: Record<string, unknown>,
  opts: { candidates?: string[]; onPick?: (name: string) => void } = {},
) {
  const candidates = opts.candidates ?? ['甲', '乙', '丙'];
  const picked: string[] = [];
  const wrapper = mount(ComboboxShell, {
    props: { id: 'cmb-test', candidateCount: candidates.length, ...props },
    slots: {
      default: ({
        activeIndex,
        optId,
      }: {
        activeIndex: number;
        optId: (i: number) => string;
      }) =>
        candidates.map((name, i) =>
          h(
            'button',
            {
              type: 'button',
              'data-combobox-candidate': true,
              id: optId(i),
              role: 'option',
              'aria-selected': i === activeIndex,
              class: 'test-candidate',
              onClick: () => {
                picked.push(name);
                opts.onPick?.(name);
              },
            },
            name,
          ),
        ),
    },
  });
  return { wrapper, picked };
}

const input = (w: ReturnType<typeof mount>['find'] extends never ? never : ReturnType<typeof mount>) =>
  w.find('input');

describe('ComboboxShell — 展开模式', () => {
  it('远程模式（默认）：聚焦不展开、键入展开、清空键入即收起', async () => {
    const { wrapper } = mountShell({});
    const inp = wrapper.find('input');
    await inp.trigger('focus');
    expect(wrapper.find('.z-50').exists()).toBe(false);
    await inp.setValue('600');
    expect(wrapper.find('.z-50').exists()).toBe(true);
    await inp.setValue('');
    expect(wrapper.find('.z-50').exists()).toBe(false);
  });

  it('浏览模式 openOnFocus：聚焦即展开全部候选', async () => {
    const { wrapper } = mountShell({ openOnFocus: true });
    await wrapper.find('input').trigger('focus');
    expect(wrapper.findAll('.test-candidate').length).toBe(3);
  });
});

describe('ComboboxShell — 键盘导航与 ARIA（L-1）', () => {
  it('ARIA：combobox 角色 + aria-expanded + 激活项 activedescendant', async () => {
    const { wrapper } = mountShell({ openOnFocus: true });
    const inp = wrapper.find('input');
    expect(inp.attributes('role')).toBe('combobox');
    expect(inp.attributes('aria-expanded')).toBe('false');
    await inp.trigger('focus');
    expect(inp.attributes('aria-expanded')).toBe('true');
    await inp.trigger('keydown', { key: 'ArrowDown' });
    expect(inp.attributes('aria-activedescendant')).toBe('cmb-test-opt-0');
  });

  it('↓/↑ 移动激活项、Enter 确认并复位', async () => {
    const { wrapper } = mountShell({ openOnFocus: true });
    const inp = wrapper.find('input');
    await inp.trigger('focus');
    await inp.trigger('keydown', { key: 'ArrowDown' });
    await inp.trigger('keydown', { key: 'ArrowDown' });
    const opts = wrapper.findAll('[role="option"]');
    expect(opts[0].attributes('aria-selected')).toBe('false');
    expect(opts[1].attributes('aria-selected')).toBe('true');
    await inp.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('selectIndex')?.[0]).toEqual([1]);
    // 复位：输入清空（回显 value）、下拉关闭
    expect(wrapper.find('.z-50').exists()).toBe(false);
    expect((inp.element as HTMLInputElement).value).toBe('');
  });

  it('↑ 在无激活项时不越界；Esc 关闭下拉', async () => {
    const { wrapper } = mountShell({ openOnFocus: true });
    const inp = wrapper.find('input');
    await inp.trigger('focus');
    await inp.trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.findAll('[role="option"]')[0].attributes('aria-selected')).toBe('false');
    await inp.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.z-50').exists()).toBe(false);
  });
});

describe('ComboboxShell — 选中与清除', () => {
  it('点击候选：外壳复位（清输入、关下拉），候选 click 由父级处理', async () => {
    const { wrapper, picked } = mountShell({ openOnFocus: true });
    await wrapper.find('input').trigger('focus');
    await wrapper.findAll('.test-candidate')[1].trigger('click');
    expect(picked).toEqual(['乙']);
    expect(wrapper.find('.z-50').exists()).toBe(false);
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
  });

  it('输入经 @search 抛出原文', async () => {
    const { wrapper } = mountShell({});
    await wrapper.find('input').setValue(' 茅台 ');
    expect(wrapper.emitted('search')?.[0]).toEqual([' 茅台 ']);
  });

  it('清除叉：emit clear 并复位输入（value 回显非空时清叉常显）', async () => {
    const { wrapper } = mountShell({ openOnFocus: true, value: '已选（600001）' });
    const clearBtn = wrapper.find('[aria-label="清除"]');
    expect(clearBtn.exists()).toBe(true);
    await clearBtn.trigger('click');
    expect(wrapper.emitted('clear')).toHaveLength(1);
    // 复位后回显 value 仍非空 → 清叉依设计常显；输入切搜索态验证复位生效
    await wrapper.find('input').setValue('600');
    expect(wrapper.emitted('search')?.[0]).toEqual(['600']);
  });
});

describe('ComboboxShell — 状态三态（L-2）', () => {
  it('loading / error / empty 三态渲染（loading/error 时不渲染候选插槽）', async () => {
    const loading = mountShell({ openOnFocus: true, loading: true });
    await loading.wrapper.find('input').trigger('focus');
    expect(loading.wrapper.text()).toContain('加载中');
    expect(loading.wrapper.findAll('.test-candidate').length).toBe(0);

    const err = mountShell({ openOnFocus: true, error: true });
    await err.wrapper.find('input').trigger('focus');
    expect(err.wrapper.text()).toContain('加载失败');
    expect(err.wrapper.findAll('.test-candidate').length).toBe(0);

    const empty = mountShell({ openOnFocus: true, candidateCount: 0 });
    await empty.wrapper.find('input').trigger('focus');
    expect(empty.wrapper.text()).toContain('无匹配结果');
    expect(empty.wrapper.findAll('.test-candidate').length).toBe(0);
  });
});
