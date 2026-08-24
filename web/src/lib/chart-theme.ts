/**
 * lib/chart-theme.ts — ECharts 图表主题桥（JS ↔ CSS 变量）
 *
 * 背景：ECharts canvas 不解析 CSS 变量，且 zrender 颜色解析器不支持 CSS Color 4
 * 的空格 HSL 语法（静默失败返回 null）。本模块在运行时从 computedStyle 读取
 * shadcn 的 HSL 分量变量（空格分隔），转为逗号分隔的 hsl() 供 canvas 使用。
 *
 * 同时提供响应式 useChartTheme()：监听 <html> 的 .dark class 变化，使图表在
 * 明暗主题切换时自动重算 option、跟随主题（修复原硬编码「暗色发飘」问题）。
 */
import { computed, ref } from 'vue';

export interface ChartTheme {
  /** 上涨 / 盈利 / 存入（红） */
  up: string;
  /** 下跌 / 亏损 / 取出（绿） */
  down: string;
  /** 网格线 */
  grid: string;
  /** 轴标签 */
  axis: string;
  /** 主折线（累计净值 / 总资产） */
  line: string;
  /** 次级折线（当年净值） */
  lineSecondary: string;
  /** 手工记录散点标记 */
  manual: string;
}

/**
 * 无 CSS 变量环境（jsdom / SSR）兜底，值与 index.css 浅色主题及既有硬编码一致。
 * 保证单测在 jsdom（未注入样式表）下产出的颜色字符串与原硬编码逐字一致，零回归。
 */
const FALLBACK: ChartTheme = {
  up: 'hsl(0, 84%, 48%)',
  down: 'hsl(142, 71%, 38%)',
  grid: 'hsl(214.3, 31.8%, 91.4%)',
  axis: 'hsl(215.4, 16.3%, 46.9%)',
  line: 'hsl(217, 91%, 60%)',
  lineSecondary: 'hsl(142, 71%, 45%)',
  manual: 'hsl(0, 84%, 48%)',
};

function readVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** CSS Color 4 空格 HSL 分量 → 逗号分隔 hsl()（zrender 仅认逗号语法）。
 *  兜底值已是完整 hsl() 时原样返回，避免二次包裹。 */
function toHsl(hslComponents: string): string {
  const trimmed = hslComponents.trim();
  if (trimmed.toLowerCase().startsWith('hsl(')) return trimmed;
  return `hsl(${trimmed.replace(/\s+/g, ', ')})`;
}

/**
 * 读取当前主题下的图表配色（纯函数，供纯函数式 option 构造与测试兜底使用）。
 * 真实浏览器下读取 .dark 切换后的计算值，自动跟随明暗主题。
 */
export function getChartTheme(): ChartTheme {
  return {
    up: toHsl(readVar('--color-up', FALLBACK.up)),
    down: toHsl(readVar('--color-down', FALLBACK.down)),
    grid: toHsl(readVar('--border', FALLBACK.grid)),
    axis: toHsl(readVar('--muted-foreground', FALLBACK.axis)),
    line: toHsl(readVar('--chart-line', FALLBACK.line)),
    lineSecondary: toHsl(readVar('--color-down', FALLBACK.lineSecondary)),
    manual: toHsl(readVar('--color-up', FALLBACK.manual)),
  };
}

// 响应式主题信号：监听 <html> 的 .dark class 变化。
// 模块级单例 —— 任意图表组件调用 useChartTheme() 即共享同一信号，主题切换时统一重算。
const themeMode = ref(false);
if (typeof document !== 'undefined') {
  themeMode.value = document.documentElement.classList.contains('dark');
  const observer = new MutationObserver(() => {
    themeMode.value = document.documentElement.classList.contains('dark');
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
}

/**
 * 响应式图表主题。在图表 option 的 computed 中读取其 .value（或作为参数传入纯函数），
 * 即可在明暗主题切换时自动触发 option 重算，使 ECharts 跟随主题配色。
 */
export function useChartTheme() {
  return computed(() => {
    // 读取 themeMode 以建立响应式依赖
    void themeMode.value;
    return getChartTheme();
  });
}
