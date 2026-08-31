/**
 * jsdom 缺失的浏览器 API 兜底（reka-ui 组件挂载需要）。
 *
 * 超集：覆盖各测试文件曾逐份复制的全部 polyfill
 * （ResizeObserver / matchMedia / scrollIntoView / hasPointerCapture /
 * releasePointerCapture），均带 `if (!X)` 幂等守卫，未安装的才补，
 * 重复安装无副作用。集中维护后，单一来源即可供全部测试复用。
 */
export function installJsdomPolyfills(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false;
    };
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture =
      function releasePointerCapture(): void {};
  }
}
