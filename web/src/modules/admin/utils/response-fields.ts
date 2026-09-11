/**
 * modules/admin/utils/response-fields.ts — 响应字段映射纯逻辑（无框架依赖）
 *
 * 与后端 backend/app/services/response_path.py / response_fields.py 语义一一对应：
 * parseSourcePath（source 路径校验）、guessSlotForColumn（预填猜测表）、
 * prefillRowsFromRaw（试调 raw → 映射行）、fieldRowsFromSpecs / fieldRowsFromLegacyColumns
 * （编辑回填）、buildResponseFields（payload 组装，全空返回 null）、missingRequiredSlots
 * （按契约端点的分类必填检查）。仅供组件与单测引用，不发起网络请求。
 */
import type { ResponseFieldSchema, ResponseFieldSpec } from '@/api/quote-interface.api';

/** source 路径段数上限（后端 MAX_SOURCE_SEGMENTS = 5） */
export const MAX_SOURCE_SEGMENTS = 5;

/** key 白名单（后端 KEY_PATTERN：首字符必须小写字母，已含下划线） */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** scale 允许范围（后端 SCALE_MIN / SCALE_MAX） */
export const SCALE_MIN = 0;
export const SCALE_MAX = 8;

/**
 * 字段映射表格的一行（表单态）。
 * - slot 为空串 = 「仅展示」（不参与同步，方案 §5.2）
 * - scale 用字符串承载输入框原始值（空串 = 不设置），组装时再转数字
 * - advancedOpen 仅为 UI 展开态，组装 payload 时忽略
 */
export interface FieldMappingRow {
  key: string;
  label: string;
  slot: string;
  source: string;
  type: string;
  required: boolean;
  unit: string;
  scale: string;
  dateFormat: string;
  advancedOpen: boolean;
}

/** source 路径校验结果：ok = 合法；empty = 空串（HEAD 语义）；invalid = 非法（含原因） */
export interface SourcePathCheck {
  status: 'ok' | 'empty' | 'invalid';
  message: string;
  segmentCount: number;
}

/**
 * source 路径校验（与后端 response_path.parse_source 逐分支对齐）：
 * `\` 转义下一字符（末尾孤立 `\` 按字面处理不报错）；`.` 分段；`[N]` 下标须非负整数、
 * 未闭合报错；冲刷后无任何段报「解析为空」；段数 > 5 报超上限；
 * 空串 = HEAD 语义（运行时合法），但静态校验要求非空（保存会 400）。
 */
export function parseSourcePath(source: string): SourcePathCheck {
  if (typeof source !== 'string' || source.length === 0) {
    return {
      status: 'empty',
      message: '空路径 = HEAD（整行语义）；保存时后端要求 source 非空',
      segmentCount: 0,
    };
  }
  let segmentCount = 0;
  let buf = false; // 当前是否正在积攒 key 段字符
  let i = 0;
  const n = source.length;

  /** 冲刷积攒缓冲为 1 个 key 段（后端 _flush_key：仅缓冲非空才计段） */
  const flushKey = (): void => {
    if (buf) {
      segmentCount += 1;
      buf = false;
    }
  };

  while (i < n) {
    const ch = source[i];
    if (ch === '\\') {
      // 转义：下一字符作为字面字符；末尾孤立反斜杠按字面反斜杠（与后端一致，不报错）
      i += 1;
      if (i < n) {
        buf = true;
        i += 1;
      } else {
        buf = true;
      }
      continue;
    }
    if (ch === '.') {
      flushKey();
      i += 1;
      continue;
    }
    if (ch === '[') {
      flushKey();
      const close = source.indexOf(']', i);
      if (close === -1) {
        return { status: 'invalid', message: `路径缺少 ']'：${source}`, segmentCount };
      }
      const inner = source.slice(i + 1, close).trim();
      if (!/^\d+$/.test(inner)) {
        return {
          status: 'invalid',
          message: `数组下标必须为非负整数：${source}`,
          segmentCount,
        };
      }
      segmentCount += 1;
      i = close + 1;
      continue;
    }
    buf = true;
    i += 1;
  }
  flushKey();
  if (segmentCount === 0) {
    return { status: 'invalid', message: `路径解析为空：${source}`, segmentCount };
  }
  if (segmentCount > MAX_SOURCE_SEGMENTS) {
    return {
      status: 'invalid',
      message: `路径段数 ${segmentCount} 超过上限 ${MAX_SOURCE_SEGMENTS}`,
      segmentCount,
    };
  }
  return { status: 'ok', message: `路径合法（${segmentCount} 段）`, segmentCount };
}

/** key 是否合法（后端 KEY_PATTERN） */
export function isValidFieldKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * 由任意文本（列名 / source / label）派生合法 key 候选：小写化 → 非 [a-z0-9_] 折叠为
 * `_` → 去首尾 `_` → 非小写字母开头补 `f` → 截断 64。派生不出（如纯中文列名）返回空串。
 */
export function sanitizeKeyCandidate(raw: string): string {
  const replaced = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!replaced) return '';
  const fixed = /^[a-z]/.test(replaced) ? replaced : `f${replaced}`;
  return fixed.slice(0, 64);
}

/** 为行确定最终 key：合法 key 优先（重复追加序号），否则按 slot → source → label → fieldN 派生，保证接口内唯一 */
export function deriveUniqueKey(row: FieldMappingRow, fallbackIndex: number, used: Set<string>): string {
  const candidates = [
    row.key.trim(),
    sanitizeKeyCandidate(row.key.trim()),
    sanitizeKeyCandidate(row.slot),
    sanitizeKeyCandidate(row.source.trim()),
    sanitizeKeyCandidate(row.label.trim()),
    `field${fallbackIndex + 1}`,
  ];
  for (const raw of candidates) {
    if (!raw || !isValidFieldKey(raw)) continue;
    if (!used.has(raw)) {
      used.add(raw);
      return raw;
    }
    // 合法但重复：追加 _2 / _3 直到唯一
    for (let n = 2; ; n += 1) {
      const suffixed = `${raw.slice(0, 64 - String(n).length - 1)}_${n}`;
      if (!used.has(suffixed)) {
        used.add(suffixed);
        return suffixed;
      }
    }
  }
  // 理论不可达（fieldN 兜底恒合法），防御性返回
  const fallback = `field${fallbackIndex + 1}`;
  used.add(fallback);
  return fallback;
}

/** 预填猜测表（方案 §7 第 4 层）：按列名猜 slot；猜不中返回空串（仅展示） */
const SLOT_GUESS_RULES: Array<{ slot: string; match: (name: string) => boolean }> = [
  { slot: 'code', match: (n) => n === '代码' },
  { slot: 'name', match: (n) => n.includes('名称') || n.includes('简称') },
  { slot: 'price', match: (n) => n.includes('最新价') || n.includes('收盘') },
  { slot: 'exchange', match: (n) => n === 'market' || n === 'exchange' },
  { slot: 'date', match: (n) => n === '日期' || n === 'date' || n === 'trade_date' },
];

/** 按列名猜 slot（供一键预填与单测；英文列名大小写不敏感） */
export function guessSlotForColumn(columnName: string): string {
  const name = columnName.trim();
  const lower = name.toLowerCase();
  for (const rule of SLOT_GUESS_RULES) {
    if (rule.match(name) || rule.match(lower)) return rule.slot;
  }
  return '';
}

/** 按猜测 slot 给默认 type（price → decimal，date → date，其余 string） */
function defaultTypeForSlot(slot: string): string {
  return slot === 'price' ? 'decimal' : slot === 'date' ? 'date' : 'string';
}

/** 新建一行空白映射（slot 空 = 仅展示） */
export function emptyFieldRow(): FieldMappingRow {
  return {
    key: '', label: '', slot: '', source: '',
    type: 'string', required: false, unit: 'none',
    scale: '', dateFormat: '', advancedOpen: false,
  };
}

/** 编辑回填：response_fields（新结构）→ 表单行；slot 为 null / 缺省 → 「仅展示」 */
export function fieldRowsFromSpecs(specs: ResponseFieldSpec[]): FieldMappingRow[] {
  return specs.map((spec) => ({
    key: spec.key ?? '',
    label: spec.label ?? '',
    slot: spec.slot ?? '',
    source: spec.source ?? '',
    type: spec.type ?? 'string',
    required: Boolean(spec.required),
    unit: spec.unit ?? 'none',
    scale: spec.scale != null ? String(spec.scale) : '',
    dateFormat: spec.date_format ?? '',
    advancedOpen: false,
  }));
}

/**
 * 编辑回填：老数据（response_fields 为 NULL）由旧 4 列 + resp_date_field 预填出等价
 * 字段行——即后端 fold_legacy_columns 的前端镜像，用户保存后即落新结构。逐项对齐：
 * code/name/price 三槽恒产出（取旧列模型默认值）；exchange/date 仅显式提供时产出；
 * 分红/公告用途（分类 3/4）code 源遗留占位 "code" 替换为中文列名兜底 "代码"。
 */
export function fieldRowsFromLegacyColumns(args: {
  categoryId: string | null;
  respCodeField: string | null;
  respPriceField: string | null;
  respNameField: string | null;
  respExchangeField: string | null;
  respDateField: string | null;
}): FieldMappingRow[] {
  const codeSource = args.respCodeField || 'code';
  const cat = args.categoryId != null ? String(args.categoryId) : '';
  // 与后端 fold_legacy_columns 逐字对齐：仅当源为遗留占位字面 "code" 时才替换为
  // 中文列名兜底 "代码"；自定义列名（如 security_code）必须原样保留，否则保存后
  // derive_legacy_columns 会把镜像列 resp_code_field 覆写成 "代码"，静默丢失自定义列。
  const displaySource =
    (cat === '3' || cat === '4') && codeSource === 'code' ? '代码' : codeSource;
  const rows: FieldMappingRow[] = [
    { ...emptyFieldRow(), key: 'code', label: '证券代码', slot: 'code', source: displaySource },
    { ...emptyFieldRow(), key: 'name', label: '证券名称', slot: 'name', source: args.respNameField || 'name' },
    {
      ...emptyFieldRow(),
      key: 'price',
      label: '价格 / 收盘价',
      slot: 'price',
      source: args.respPriceField || 'price',
      type: 'decimal',
    },
  ];
  if (args.respExchangeField) {
    rows.push({
      ...emptyFieldRow(),
      key: 'exchange',
      label: '交易所',
      slot: 'exchange',
      source: args.respExchangeField,
    });
  }
  if (args.respDateField) {
    rows.push({
      ...emptyFieldRow(),
      key: 'date',
      label: '日期',
      slot: 'date',
      source: args.respDateField,
      type: 'date',
    });
  }
  return rows;
}

/**
 * 表单行 → response_fields 载荷（方案 §7）：保持「全空返回 null」既有约定。
 * - 无任何有意义内容（source / label / slot 全空）的行被丢弃；丢弃后为空 → null
 * - key 自动派生并保证唯一（合法 key 优先沿用）
 * - scale 仅 decimal 且 0~8 的合法整数才携带；unit 仅非 none 携带；date_format 仅 date 携带
 */
export function buildResponseFields(rows: FieldMappingRow[]): ResponseFieldSpec[] | null {
  const meaningful = rows.filter(
    (r) => r.source.trim() !== '' || r.label.trim() !== '' || r.slot !== '',
  );
  if (meaningful.length === 0) return null;
  const used = new Set<string>();
  const specs: ResponseFieldSpec[] = [];
  meaningful.forEach((row, idx) => {
    const type = row.type || 'string';
    const spec: ResponseFieldSpec = {
      key: deriveUniqueKey(row, idx, used),
      source: row.source.trim(),
      type,
      required: Boolean(row.required),
    };
    const label = row.label.trim();
    if (label) spec.label = label;
    const slot = row.slot.trim();
    if (slot) spec.slot = slot;
    if (type === 'decimal' && row.scale.trim() !== '') {
      const scale = Number(row.scale);
      if (Number.isInteger(scale) && scale >= SCALE_MIN && scale <= SCALE_MAX) {
        spec.scale = scale;
      }
    }
    if (row.unit && row.unit !== 'none') spec.unit = row.unit;
    if (type === 'date' && row.dateFormat.trim() !== '') {
      spec.date_format = row.dateFormat.trim();
    }
    specs.push(spec);
  });
  return specs;
}

/** 按契约端点计算当前分类缺失的必填 slot（无契约的分类返回空数组） */
export function missingRequiredSlots(
  rows: FieldMappingRow[],
  schema: ResponseFieldSchema | null,
  categoryId: string,
): string[] {
  const contract = schema?.contracts?.[String(categoryId)];
  if (!contract || contract.required.length === 0) return [];
  const present = new Set(rows.map((r) => r.slot.trim()).filter(Boolean));
  return contract.required.filter((slot) => !present.has(slot));
}

/** slot 下拉选项展示文案：命中当前分类契约必填的槽位加 * 后缀（供表格组件与单测共用） */
export function slotLabelWithContract(value: string, label: string, requiredSlots: string[]): string {
  return requiredSlots.includes(value) ? `${label} *` : label;
}

/** 一键预填结果：生成的行 + 需要人工校正的提示 */
export interface PrefillResult {
  rows: FieldMappingRow[];
  warnings: string[];
}

/** 单次预填最多生成的列数（防止宽表生成数百行淹没表单） */
const PREFILL_MAX_COLUMNS = 30;

/**
 * 一键预填（方案 §7 第 4 层）：从试调 raw 首行提取顶层 key 生成字段行。
 * raw 为数组取首行；首行仍是数组 → 提示按位置下标填写（边界 8）；raw 为 dict 视作单行；
 * 识别 `_code` 键 → 提示可作 source（边界 7）；两列猜中同一 slot → 后者置空并提示
 * 人工校正（slot 不可重复）。
 */
export function prefillRowsFromRaw(raw: unknown): PrefillResult {
  const warnings: string[] = [];
  let firstRow: unknown = raw;
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return { rows: [], warnings: ['试调返回为空数组，无列可提取'] };
    }
    firstRow = raw[0];
  }
  if (Array.isArray(firstRow)) {
    warnings.push('数组行：无法提取列名，请按位置下标填写 source（如 0 / 1）');
    return { rows: [], warnings };
  }
  if (firstRow == null || typeof firstRow !== 'object') {
    warnings.push(
      '首行为标量（text_split 行）：请按位置下标填写 source（如 0 / 1）；注入的 _code 为带前缀代码键',
    );
    return { rows: [], warnings };
  }
  const entries = Object.entries(firstRow as Record<string, unknown>).filter(
    ([k]) => typeof k === 'string',
  );
  if (entries.some(([k]) => k === '_code')) {
    warnings.push('检测到 text_split 注入的特殊键 _code（带前缀代码），对应行可直接使用 source=_code');
  }
  if (entries.length > PREFILL_MAX_COLUMNS) {
    warnings.push(`共 ${entries.length} 列，仅取前 ${PREFILL_MAX_COLUMNS} 列，请人工补齐或删减`);
  }
  const usedSlots = new Set<string>();
  const rows = entries.slice(0, PREFILL_MAX_COLUMNS).map(([col]) => {
    const guessed = guessSlotForColumn(col);
    let slot = guessed;
    if (guessed && usedSlots.has(guessed)) {
      slot = '';
      warnings.push(`列「${col}」与先前列同时猜为 ${guessed} 槽（slot 不可重复），已置为仅展示，请人工校正`);
    }
    if (slot) usedSlots.add(slot);
    return {
      ...emptyFieldRow(),
      label: col,
      slot,
      source: col,
      type: defaultTypeForSlot(slot),
    };
  });
  return { rows, warnings };
}
