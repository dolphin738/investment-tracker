/**
 * lib/url-query.ts — 通用 URL ↔ React state 同步 Hook（useUrlState）+ codec 原语
 *
 * 设计目标（对齐 features/cashflow/query-params.ts 的纯函数范式，并升级为受控 Hook）：
 * - 页面筛选 / 分页 / 排序等状态写入 URL query，刷新 / 分享后保持（PRD 多页对齐需求）。
 * - 参数名由 schema 白名单决定；白名单外的 URL key **忽略**（读取忽略、写入保留）。
 * - **等于默认值的字段不写入 URL**（保持 URL 干净、可分享）。
 * - **非法值静默降级为默认值**（不抛错、不 400）。
 * - **连续 setState 合并为一次 history.replaceState**（不污染浏览器历史）。
 *
 * 与 react-router 解耦：直接读写 `window.location` + `history.replaceState` +
 * 监听 `popstate`，便于在 jsdom 单测中无需路由上下文即可验证。
 *
 * 🔴 铁律：所有金额 / 日期仍以 string 在 URL 中传输，前端不得在此做 Number() 运算
 * （仅 number 类型的页码 / 页大小等可解析为 number，与后端 DTO 白名单一致）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================================
// Codec 原语
// ============================================================================

/** 单个字段的编解码器：parse（URL→值）/ serialize（值→URL，null=不写入） */
export interface UrlCodec<T> {
  /** 缺省值（等于默认值时不写入 URL） */
  readonly defaultValue: T;
  /** 从 URL raw 字符串解析；非法 → defaultValue */
  parse: (raw: string | null) => T;
  /** 序列化回 URL；返回 null 表示「不写入」（等于默认值 / 空数组 / 非法） */
  serialize: (value: T) => string | null;
}

/** useUrlState 的 schema：字段名 → 该字段的 codec */
export type UrlStateSchema<T> = {
  [K in keyof T]: UrlCodec<T[K]>;
};

/** YYYY-MM-DD 格式校验 */
function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** 数字 codec：非法 / 缺失 → defaultValue */
export function numberCodec(defaultValue: number): UrlCodec<number> {
  return {
    defaultValue,
    parse: (raw) => {
      if (raw === null || raw === '') return defaultValue;
      const n = Number(raw);
      return Number.isFinite(n) ? n : defaultValue;
    },
    serialize: (value) => (value !== defaultValue ? String(value) : null),
  };
}

/** 字符串 codec：缺失 → defaultValue；等于默认值 → 不写入 */
export function stringCodec(defaultValue: string): UrlCodec<string> {
  return {
    defaultValue,
    parse: (raw) => (raw === null ? defaultValue : raw),
    serialize: (value) =>
      value !== defaultValue && value.length > 0 ? value : null,
  };
}

/** 枚举 codec：非法 / 缺失 → defaultValue（白名单校验） */
export function enumCodec<T extends string>(
  allowed: readonly T[],
  defaultValue: T,
): UrlCodec<T> {
  const set = new Set<string>(allowed);
  return {
    defaultValue,
    parse: (raw) => (raw !== null && set.has(raw) ? (raw as T) : defaultValue),
    serialize: (value) => (value !== defaultValue ? value : null),
  };
}

/** 布尔 codec：URL 中以 1|0 表示；false（默认）→ 不写入 */
export function booleanCodec(defaultValue: boolean): UrlCodec<boolean> {
  return {
    defaultValue,
    parse: (raw) => {
      if (raw === '1') return true;
      if (raw === '0') return false;
      return defaultValue;
    },
    serialize: (value) => {
      if (value === defaultValue) return null;
      return value ? '1' : '0';
    },
  };
}

/** 日期 codec：仅接受 YYYY-MM-DD；非法 → defaultValue（通常 '' 表示「全部」） */
export function dateCodec(defaultValue: string): UrlCodec<string> {
  return {
    defaultValue,
    parse: (raw) => (raw !== null && isValidDateStr(raw) ? raw : defaultValue),
    serialize: (value) =>
      value !== defaultValue && isValidDateStr(value) ? value : null,
  };
}

/** 逗号数组 codec：URL 中以逗号分隔；空数组 → 不写入 */
export function arrayCodec(defaultValue: string[]): UrlCodec<string[]> {
  return {
    defaultValue,
    parse: (raw) =>
      raw === null || raw === ''
        ? []
        : raw.split(',').filter((s) => s.length > 0),
    serialize: (value) => (value.length > 0 ? value.join(',') : null),
  };
}

// ============================================================================
// useUrlState Hook
// ============================================================================

/**
 * 将一组受 schema 约束的状态与 URL query 双向同步。
 *
 * @param schema 字段名 → codec 的映射（白名单）
 * @returns [state, setState] —— setState 接受 Partial<T> 增量补丁
 *
 * 行为要点：
 * - 初始化：从当前 `window.location.search` 按 schema 解析出 state。
 * - 读取：白名单外 key 忽略（不进入 state）。
 * - 写入：setState(patch) 合并进当前 state，仅 schema 字段被写回 URL；
 *   等于默认值的字段被省略；白名单外 key 原样保留。
 * - **合并刷新**：连续多次 setState 在微任务内合并为**一次** `history.replaceState`。
 * - 监听 `popstate`（浏览器前进/后退）→ 同步回 state。
 */
export function useUrlState<T>(
  schema: UrlStateSchema<T>,
): [T, (patch: Partial<T>) => void] {
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  /** 从当前 URL 解析出 state（仅 schema 白名单字段） */
  const readState = useCallback((): T => {
    const sp = new URLSearchParams(window.location.search);
    const out = {} as T;
    const keys = Object.keys(schemaRef.current) as Array<keyof T>;
    for (const key of keys) {
      const codec = schemaRef.current[key];
      out[key] = codec.parse(sp.get(key as string)) as T[keyof T];
    }
    return out;
  }, []);

  const [state, setStateReact] = useState<T>(readState);

  // 连续 setState 的合并缓冲：pendingRef 累积补丁，scheduledRef 保证只排一次刷新
  const pendingRef = useRef<Partial<T> | null>(null);
  const scheduledRef = useRef(false);

  const flush = useCallback(() => {
    scheduledRef.current = false;
    const patch = pendingRef.current ?? {};
    pendingRef.current = null;

    const current = readState();
    const next = { ...current, ...patch };

    // 从当前 URL 起步（保留白名单外 key），仅覆写 schema 字段
    const sp = new URLSearchParams(window.location.search);
    const keys = Object.keys(schemaRef.current) as Array<keyof T>;
    for (const key of keys) {
      const codec = schemaRef.current[key];
      const serialized = codec.serialize(next[key]);
      const paramKey = key as string;
      if (serialized === null) {
        sp.delete(paramKey);
      } else {
        sp.set(paramKey, serialized);
      }
    }

    const query = sp.toString();
    const url = query ? `?${query}` : window.location.pathname;
    window.history.replaceState(window.history.state, '', url);
    setStateReact(next);
  }, [readState]);

  const setState = useCallback(
    (patch: Partial<T>) => {
      pendingRef.current = { ...(pendingRef.current ?? {}), ...patch };
      if (!scheduledRef.current) {
        scheduledRef.current = true;
        // 微任务内合并：同一帧内的多次 setState 只触发一次 replaceState
        queueMicrotask(flush);
      }
    },
    [flush],
  );

  // 浏览器前进/后退 → 同步回 state
  useEffect(() => {
    const onPop = () => setStateReact(readState());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [readState]);

  return [state, setState];
}
