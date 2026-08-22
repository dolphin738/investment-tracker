/**
 * composables/use-persistent-tab.ts — Tab 页签刷新持久化（统一范式）
 *
 * 金融数据接口页（AdminPage）已验证可用：当前激活页签持久化到 localStorage，
 * 刷新网页后仍停留在同一分页，而非跳回默认第一个。
 *
 * 本 composable 把该范式抽成可复用封装，供全站所有「分类分页」Tab 接入：
 * - 初始化时从 localStorage 读取，命中合法值才采用，否则回退 default；
 * - 切换时写回 localStorage（隐私模式 / 配额超限静默忽略）。
 *
 * 注意：仅用于「页面内部分类分页」这类无需进分享链接的场景。
 * 需要刷新/分享/前进后退都还原的（如筛选、排序、维度），应走 URL query 而非此处。
 */
import { ref, watch, type Ref } from 'vue';

/**
 * @param storageKey   localStorage 键（建议带命名空间前缀，如 'invest:xxx-tab'）
 * @param defaultValue 默认页签值（localStorage 无记录或读取失败时使用）
 * @param validValues  合法页签值集合；提供后读取到非法值会回退 default（防御脏数据）
 */
export function usePersistentTab(
  storageKey: string,
  defaultValue: string,
  validValues?: readonly string[],
): Ref<string> {
  function read(): string {
    try {
      const v = localStorage.getItem(storageKey);
      if (v && (validValues === undefined || validValues.includes(v))) {
        return v;
      }
    } catch {
      /* 隐私模式 / 存储不可用：忽略，回落默认 */
    }
    return defaultValue;
  }

  function write(value: string): void {
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      /* 隐私模式 / 配额：忽略持久化失败 */
    }
  }

  const tab = ref<string>(read());

  // 切换页签时同步持久化（flush: sync 确保与状态变更同帧写回）
  watch(tab, (v) => write(v), { flush: 'sync' });

  return tab;
}
