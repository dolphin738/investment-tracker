/**
 * lib/__tests__/url-query.spec.ts — useUrlState + codec 单测（T01 验收3）
 *
 * 覆盖 4 条核心契约：
 * 1. 等于默认值的字段不写入 URL
 * 2. 非法值静默降级为默认值
 * 3. 白名单外 key 忽略（读取忽略 + 写入保留）
 * 4. 连续 setState 合并为一次 history.replaceState
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import * as React from 'react';
import {
  arrayCodec,
  booleanCodec,
  dateCodec,
  enumCodec,
  numberCodec,
  stringCodec,
  useUrlState,
  type UrlStateSchema,
} from '@/lib/url-query';

interface TestState {
  page: number;
  q: string;
  type: 'a' | 'b';
  flag: boolean;
  date: string;
  tags: string[];
}

function makeSchema(): UrlStateSchema<TestState> {
  return {
    page: numberCodec(1),
    q: stringCodec(''),
    type: enumCodec(['a', 'b'] as const, 'a'),
    flag: booleanCodec(false),
    date: dateCodec(''),
    tags: arrayCodec<string>([]),
  };
}

/**
 * 渲染 useUrlState 并暴露最新的 state / setState（react-hooks 风格测试，
 * 不依赖 react-router 上下文）。
 */
function setup(initialSearch: string) {
  window.history.replaceState(null, '', initialSearch || '/');
  const api: { state: TestState; setState: (patch: Partial<TestState>) => void } = {
    state: {} as TestState,
    setState: () => {},
  };
  function Wrapper() {
    const [state, setState] = useUrlState<TestState>(makeSchema());
    api.state = state;
    api.setState = setState;
    return null;
  }
  render(React.createElement(Wrapper));
  return api;
}

/** 等待微任务队列清空（useUrlState 的合并刷新在 queueMicrotask 中执行） */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('useUrlState — 默认值不入 URL', () => {
  it('所有字段取默认值时，刷新不产生任何 query 参数', async () => {
    const api = setup('/');
    const spy = vi.spyOn(window.history, 'replaceState');

    act(() => {
      api.setState({ page: 1, q: '', type: 'a', flag: false, date: '', tags: [] });
    });
    await flushMicrotasks();

    // 仅一次 replaceState，且 URL 不含任何业务参数
    expect(spy).toHaveBeenCalledTimes(1);
    const url = (spy.mock.calls[0]?.[2] as string) ?? '';
    expect(url).toBe('/');
    expect(url).not.toContain('page');
    expect(url).not.toContain('q');
    spy.mockRestore();
  });

  it('布尔 false（默认）不写入，true 写为 1', async () => {
    const api = setup('/');
    const spy = vi.spyOn(window.history, 'replaceState');

    act(() => {
      api.setState({ flag: false });
    });
    await flushMicrotasks();
    expect((spy.mock.calls[0]?.[2] as string)).toBe('/');

    act(() => {
      api.setState({ flag: true });
    });
    await flushMicrotasks();
    expect((spy.mock.calls[1]?.[2] as string)).toContain('flag=1');
    spy.mockRestore();
  });
});

describe('useUrlState — 非法值静默降级默认', () => {
  it('page=abc 降级为默认 1', () => {
    const api = setup('/?page=abc');
    expect(api.state.page).toBe(1);
  });

  it('type=zzz（非白名单）降级为默认 a', () => {
    const api = setup('/?type=zzz');
    expect(api.state.type).toBe('a');
  });

  it('date=2026/01/01（非法格式）降级为空串', () => {
    const api = setup('/?date=2026/01/01');
    expect(api.state.date).toBe('');
  });

  it('flag=x（非 1/0）降级为默认 false', () => {
    const api = setup('/?flag=x');
    expect(api.state.flag).toBe(false);
  });
});

describe('useUrlState — 白名单外 key 忽略', () => {
  it('读取时忽略未知 key（不进入 state）', () => {
    const api = setup('/?page=2&unknown=foo&another=bar');
    expect(api.state.page).toBe(2);
    // state 仅有 schema 白名单字段，未知 key 不出现
    expect('unknown' in api.state).toBe(false);
    expect('another' in api.state).toBe(false);
  });

  it('写入时保留未知 key（不误删）', async () => {
    const api = setup('/?page=2&unknown=foo');
    const spy = vi.spyOn(window.history, 'replaceState');

    act(() => {
      api.setState({ page: 3 });
    });
    await flushMicrotasks();

    const url = (spy.mock.calls[0]?.[2] as string) ?? '';
    expect(url).toContain('page=3');
    expect(url).toContain('unknown=foo'); // 未知 key 被原样保留
    spy.mockRestore();
  });
});

describe('useUrlState — 连续 setState 合并一次 replace', () => {
  it('同一微任务内的多次 setState 只触发一次 history.replaceState', async () => {
    const api = setup('/');
    const spy = vi.spyOn(window.history, 'replaceState');

    act(() => {
      api.setState({ page: 2 });
      api.setState({ page: 3 });
      api.setState({ q: 'hello' });
    });
    await flushMicrotasks();

    expect(spy).toHaveBeenCalledTimes(1);
    const url = (spy.mock.calls[0]?.[2] as string) ?? '';
    expect(url).toContain('page=3');
    expect(url).toContain('q=hello');
    // 最终 state 为最后一次补丁的合并结果
    expect(api.state.page).toBe(3);
    expect(api.state.q).toBe('hello');
    spy.mockRestore();
  });

  it('分两次（跨微任务）setState 各自触发一次 replace', async () => {
    const api = setup('/');
    const spy = vi.spyOn(window.history, 'replaceState');

    act(() => {
      api.setState({ page: 2 });
    });
    await flushMicrotasks();
    act(() => {
      api.setState({ page: 5 });
    });
    await flushMicrotasks();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(api.state.page).toBe(5);
    spy.mockRestore();
  });
});
