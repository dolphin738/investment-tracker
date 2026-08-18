/**
 * modules/admin/features/reorder.ts — 接口分类内拖拽排序算法（ADR-002 优先级链）
 *
 * 平移自 React 版 features/admin/quote-provider-section.tsx 的 computeReorderedIds。
 * 计算拖拽后的新有序 id 列表（priority = index）。纯函数，便于单测。
 * - activeId / overId 任一不在列表中 → 原样返回；
 * - 拖到原位（oldIndex === newIndex）→ 原样返回；
 * - 否则按数组移动语义重排。
 */
export function computeReorderedIds(
  ids: readonly string[],
  activeId: string,
  overId: string,
): string[] {
  const oldIndex = ids.indexOf(activeId);
  const newIndex = ids.indexOf(overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
    return [...ids];
  }
  const next = [...ids];
  next.splice(newIndex, 0, next.splice(oldIndex, 1)[0]);
  return next;
}