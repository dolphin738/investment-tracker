/**
 * api-client 请求拦截器测试（M2 回归）
 *
 * M2 的问题：axios 实例上写死了 'Content-Type': 'application/json'，
 * axios 的 transformRequest 看到 JSON 类型头后会调用 formDataToJSON()
 * 把 FormData 序列化成 JSON 字符串 —— 后端 multer 收不到任何文件，
 * 表现为「点了上传没反应 / 提示请选择图片」。
 *
 * 修复：请求拦截器检测到 config.data instanceof FormData 时删除该头，
 * 让浏览器自动补 multipart/form-data; boundary=...
 *
 * 测试策略：mock 掉 XMLHttpRequest 而不是替换 axios 的 adapter。
 * 原因：axios 真正决定最终请求头的链路是
 *   请求拦截器 → transformRequest → dispatchRequest（给 post/put/patch 补
 *   application/x-www-form-urlencoded 默认头）→ xhr adapter/resolveConfig
 *   （检测到 FormData 时 setContentType(undefined) 交还给浏览器）。
 * 如果替换 adapter，最后一步会被跳过，测出来的头是假象。
 * 只有保留真实 adapter、在 XHR 层捕获 setRequestHeader，
 * 断言的才是「实际发出去的请求头」。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosRequestConfig } from 'axios';

// sonner 的 toast 在 jsdom 下会尝试渲染，直接 mock 掉
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

/** 捕获到的最终出网请求 */
interface Captured {
  headers: Record<string, string>;
  body: unknown;
}

/** 在实际 setRequestHeader 过的头里找 content-type（大小写不敏感） */
function findContentType(headers: Record<string, string>): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  return key === undefined ? undefined : headers[key];
}

/** 最小 XMLHttpRequest 桩：记录真实发出的头与 body，并立即回一个成功信封 */
function installFakeXHR(onCapture: (c: Captured) => void): () => void {
  const original = globalThis.XMLHttpRequest;

  class FakeXHR {
    static readonly DONE = 4;
    readyState = 4;
    status = 200;
    statusText = 'OK';
    responseType = '';
    response = JSON.stringify({ code: 0, data: { ok: true }, message: 'success' });
    responseText = this.response;
    onloadend: (() => void) | null = null;
    upload = { addEventListener: (): void => undefined, removeEventListener: (): void => undefined };
    private readonly headers: Record<string, string> = {};

    open(): void {}
    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }
    getAllResponseHeaders(): string {
      return 'content-type: application/json\r\n';
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    abort(): void {}
    send(body: unknown): void {
      onCapture({ headers: { ...this.headers }, body });
      // 用微任务而非真实定时器 setTimeout(0) 触发完成。
      //
      // 根因（遗留 #1）：原实现依赖真实定时器回调驱动 axios Promise，
      // 在 vitest 默认 threads 池「全量并发」下（叠加本地 CPU/内存争用），
      // 该定时器回调会被事件循环饿死，导致 axios Promise 偶发超过 5s 超时。
      // 单独运行无并发争用时 7/7 稳定通过，正是此症结。
      //
      // 微任务不进入定时器队列，且同文件内 `send` 调用期间无其他任务阻塞，
      // 因此完成时机确定、不会抖动，从根上消除「并发超时」类失败。
      void Promise.resolve().then(() => this.onloadend?.());
    }
  }

  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  return () => {
    globalThis.XMLHttpRequest = original;
  };
}

describe('api-client 请求拦截器（M2）', () => {
  let captured: Captured | undefined;
  let restoreXHR: (() => void) | undefined;

  beforeEach(() => {
    captured = undefined;
    localStorage.clear();
    vi.resetModules();
    restoreXHR = installFakeXHR((c) => {
      captured = c;
    });
  });

  afterEach(() => {
    try {
      restoreXHR?.();
    } finally {
      // 还原全局 XHR 引用，避免模块级/全局状态泄漏到同文件其它用例
      restoreXHR = undefined;
      // 防御性还原真实定时器：即便本文件未使用 fake timers，
      // 也兜底确保无残留 fake timers 影响后续用例（遗留 #1 隔离性加固）
      vi.useRealTimers();
      vi.clearAllMocks();
    }
  });

  // 安全网：double-check 全局 XHR 已被还原。
  // vitest 默认 afterEach 总会执行，此处仅作极端异常路径下的兜底，
  // 杜绝伪造的全局 XMLHttpRequest 泄漏污染同文件用例（遗留 #1）。
  afterAll(() => {
    if (restoreXHR) {
      restoreXHR();
      restoreXHR = undefined;
    }
  });

  /** 装载 api-client（走真实 xhr adapter） */
  async function loadClient(): Promise<{
    request: (config: AxiosRequestConfig) => Promise<unknown>;
  }> {
    const mod = await import('./api-client');
    const client = mod.default;
    return { request: (c: AxiosRequestConfig) => client.request(c) };
  }

  it('FormData 请求应删除 Content-Type，交由浏览器生成 boundary', async () => {
    // Arrange
    const { request } = await loadClient();
    const formData = new FormData();
    formData.append('file', new Blob(['fake-image-bytes'], { type: 'image/png' }), 'a.png');

    // Act
    await request({ url: '/upload/avatar', method: 'post', data: formData });

    // Assert：实际出网的请求头里完全不能有 Content-Type，
    // 只有这样浏览器才会自己补 multipart/form-data; boundary=...
    expect(captured).toBeDefined();
    expect(findContentType(captured!.headers)).toBeUndefined();
  });

  it('FormData 请求体不得被 transformRequest 序列化成 JSON 字符串', async () => {
    const { request } = await loadClient();
    const formData = new FormData();
    formData.append('file', new Blob(['bytes'], { type: 'image/png' }), 'a.png');

    await request({ url: '/upload/avatar', method: 'post', data: formData });

    // 这是 M2 真正要防的回归：body 必须仍是 FormData，而不是 '{"file":{}}'
    expect(captured!.body).toBeInstanceOf(FormData);
    expect(typeof captured!.body).not.toBe('string');
    expect((captured!.body as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('普通 JSON 请求应保留 application/json', async () => {
    const { request } = await loadClient();

    await request({ url: '/auth/profile', method: 'patch', data: { name: '张三' } });

    expect(String(findContentType(captured!.headers) ?? '')).toContain('application/json');
    expect(captured!.body).toBe(JSON.stringify({ name: '张三' }));
  });

  it('GET 请求（无 body）不受影响', async () => {
    const { request } = await loadClient();

    await request({ url: '/auth/me', method: 'get' });

    expect(captured).toBeDefined();
    expect(captured!.body).toBeNull();
  });

  it('FormData 请求仍应携带 Authorization 头（删头不得误伤 JWT）', async () => {
    localStorage.setItem('investment_tracker_token', 'jwt-token-abc');
    const { request } = await loadClient();
    const formData = new FormData();
    formData.append('file', new Blob(['bytes'], { type: 'image/png' }), 'a.png');

    await request({ url: '/upload/avatar', method: 'post', data: formData });

    const authKey = Object.keys(captured!.headers).find(
      (k) => k.toLowerCase() === 'authorization',
    );
    expect(authKey).toBeDefined();
    expect(captured!.headers[authKey!]).toBe('Bearer jwt-token-abc');
    // 同时确认 Content-Type 依旧被删掉
    expect(findContentType(captured!.headers)).toBeUndefined();
  });

  it('JSON 请求也应携带 Authorization 头', async () => {
    localStorage.setItem('investment_tracker_token', 'jwt-token-xyz');
    const { request } = await loadClient();

    await request({ url: '/auth/profile', method: 'patch', data: { bio: 'hi' } });

    const authKey = Object.keys(captured!.headers).find(
      (k) => k.toLowerCase() === 'authorization',
    );
    expect(captured!.headers[authKey!]).toBe('Bearer jwt-token-xyz');
  });

  it('反证：不删 Content-Type 时 FormData 确实会被序列化成 JSON（证明该修复是必需的）', async () => {
    // 复现修复前的实例配置：写死 application/json 且没有 FormData 拦截器
    const axios = (await import('axios')).default;
    const naive = axios.create({
      baseURL: '/api',
      headers: { 'Content-Type': 'application/json' },
    });
    const formData = new FormData();
    formData.append('file', new Blob(['bytes'], { type: 'image/png' }), 'a.png');

    await naive.post('/upload/avatar', formData);

    // 文件在这里就丢了 —— 后端 multer 收不到任何 part
    expect(typeof captured!.body).toBe('string');
    expect(captured!.body).not.toBeInstanceOf(FormData);
  });
});
