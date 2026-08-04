/**
 * ResponseInterceptor 回归测试
 *
 * 背景（Bug 1c）：upload.controller 曾手工返回 { code, data, message } 信封，
 * 而全局注册的 ResponseInterceptor 无条件再包一层，导致响应被双重包裹：
 *   { code:0, data:{ code:0, data:{url,user}, message }, message:'ok' }
 * 前端 api-client 只解一层 → data.user 为 undefined → setUser(undefined)
 * → localStorage 写入 "null" → 刷新即掉登录态。
 *
 * 本 spec 锁定拦截器的三条契约：
 * 1. 普通业务数据（含数组 / 原始值 / null）仍被正确包装**一层**信封；
 * 2. 已是信封的返回值原样透传，不二次包裹；
 * 3. isEnvelope 判定不误伤正常业务响应（尤其是带**字符串** code 的证券对象）。
 */

import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ResponseInterceptor } from './response.interceptor';

/** 让拦截器跑完一次 map，返回最终响应体 */
async function intercept<T>(value: T): Promise<unknown> {
  const interceptor = new ResponseInterceptor<T>();
  const next: CallHandler<T> = { handle: () => of(value) };
  return lastValueFrom(
    interceptor.intercept({} as ExecutionContext, next),
  );
}

describe('ResponseInterceptor', () => {
  describe('普通业务数据 → 包装一层信封', () => {
    it('对象被包装为 { code:0, data, message:"ok" }', async () => {
      const payload = { id: 'p1', name: '主组合' };

      await expect(intercept(payload)).resolves.toEqual({
        code: 0,
        data: payload,
        message: 'ok',
      });
    });

    it('数组被包装为 data（不因元素含 code 而跳过）', async () => {
      const list = [
        { id: 's1', code: '600519', name: '贵州茅台' },
        { id: 's2', code: '000001', name: '平安银行' },
      ];

      await expect(intercept(list)).resolves.toEqual({
        code: 0,
        data: list,
        message: 'ok',
      });
    });

    it('null 被包装为 data:null（而不是被误判为信封）', async () => {
      await expect(intercept(null)).resolves.toEqual({
        code: 0,
        data: null,
        message: 'ok',
      });
    });

    it('undefined 归一为 null，避免 JSON 序列化丢字段', async () => {
      const body = (await intercept(undefined)) as Record<string, unknown>;

      expect(body).toEqual({ code: 0, data: null, message: 'ok' });
      // 明确断言 data 键存在（JSON.stringify 会直接丢掉值为 undefined 的键）
      expect(Object.keys(body)).toContain('data');
      expect(JSON.parse(JSON.stringify(body))).toHaveProperty('data', null);
    });

    it.each([
      ['数字', 42],
      ['字符串', 'ok'],
      ['布尔', true],
    ])('原始值（%s）被正常包装', async (_label, value) => {
      await expect(intercept(value)).resolves.toEqual({
        code: 0,
        data: value,
        message: 'ok',
      });
    });
  });

  describe('已是信封 → 原样透传，绝不二次包裹', () => {
    it('{ code:0, data, message } 不被再包一层（Bug 1c 核心回归）', async () => {
      const envelope = {
        code: 0,
        data: { url: '/api/uploads/avatar/x.png', user: { id: 'u1' } },
        message: '上传成功',
      };

      const body = (await intercept(envelope)) as Record<string, unknown>;

      expect(body).toBe(envelope);
      // 关键：data 必须是业务数据本身，而不是嵌套的内层信封
      expect(body.data).not.toHaveProperty('code');
      expect(body.data).toHaveProperty('url');
      expect(body.data).toHaveProperty('user');
    });

    it('非 0 业务码的信封同样透传', async () => {
      const envelope = { code: 1006, data: null, message: '图片上传失败' };

      await expect(intercept(envelope)).resolves.toEqual(envelope);
    });
  });

  describe('isEnvelope 不误伤正常业务响应', () => {
    it('证券对象的 code 是字符串 → 仍被正常包装', async () => {
      const security = { id: 's1', code: '600519', name: '贵州茅台', type: 'STOCK' };

      await expect(intercept(security)).resolves.toEqual({
        code: 0,
        data: security,
        message: 'ok',
      });
    });

    it('code 为 null / 空串时不算信封', async () => {
      await expect(intercept({ code: null, name: 'x' })).resolves.toMatchObject({
        code: 0,
        message: 'ok',
      });
      await expect(intercept({ code: '', name: 'x' })).resolves.toMatchObject({
        code: 0,
        message: 'ok',
      });
    });

    it('⚠️ 契约边界：数值型 code 的业务对象会被误判为信封', async () => {
      // 这不是当前的 Bug——已核实全库无此类成功响应——
      // 但它是 isEnvelope 的固有约束：任何新增的响应 DTO 都不得带 number 型 code 字段。
      // 本用例把该约束固化下来，将来有人违反时会立刻红灯。
      const suspicious = { code: 200, name: '某个带数字 code 的业务对象' };

      await expect(intercept(suspicious)).resolves.toBe(suspicious);
    });
  });
});
