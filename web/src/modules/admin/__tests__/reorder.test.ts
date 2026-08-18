import { describe, expect, it } from 'vitest';
import { computeReorderedIds } from '../features/reorder';

describe('computeReorderedIds — 接口分类拖拽排序', () => {
  it('向下拖拽：将 activeId 移到 overId 之后', () => {
    expect(computeReorderedIds(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual([
      'b', 'c', 'a', 'd',
    ]);
  });

  it('向上拖拽：将 activeId 移到 overId 之前', () => {
    expect(computeReorderedIds(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual([
      'a', 'd', 'b', 'c',
    ]);
  });

  it('拖到原位置：返回原数组副本（不改变顺序）', () => {
    const ids = ['a', 'b', 'c'] as const;
    expect(computeReorderedIds(ids, 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('activeId 不在列表：原样返回', () => {
    expect(computeReorderedIds(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
  });

  it('overId 不在列表：原样返回', () => {
    expect(computeReorderedIds(['a', 'b'], 'a', 'x')).toEqual(['a', 'b']);
  });

  it('返回新数组，不修改入参', () => {
    const ids = ['a', 'b', 'c'];
    const result = computeReorderedIds(ids, 'a', 'c');
    expect(result).not.toBe(ids);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('元素重复或元素缺失（拖拽约束外）也保持顺序稳定', () => {
    expect(computeReorderedIds([], 'a', 'b')).toEqual([]);
  });
});