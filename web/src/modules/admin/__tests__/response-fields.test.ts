/**
 * modules/admin/__tests__/response-fields.test.ts
 *
 * 响应字段映射纯逻辑单测（utils/response-fields.ts）——对齐后端
 * backend/app/services/response_path.py / response_fields.py 语义：
 * - parseSourcePath：source 路径各分支（含 \. 转义、[0] 下标、段数上限、空串 HEAD）
 * - guessSlotForColumn：预填猜测表
 * - prefillRowsFromRaw：dict 行 / 数组行 / _code 特殊键 / slot 猜测冲突
 * - buildResponseFields：全空返回 null 约定、key 派生与唯一、scale/unit/date_format 门槛
 * - fieldRowsFromSpecs / fieldRowsFromLegacyColumns：编辑回填（新结构与旧 4 列镜像）
 * - missingRequiredSlots：按契约端点的分类必填检查
 */
import { describe, expect, it } from 'vitest';
import type { ResponseFieldSchema, ResponseFieldSpec } from '@/api/quote-interface.api';
import {
  buildResponseFields,
  emptyFieldRow,
  fieldRowsFromLegacyColumns,
  fieldRowsFromSpecs,
  guessSlotForColumn,
  isValidFieldKey,
  missingRequiredSlots,
  parseSourcePath,
  prefillRowsFromRaw,
  slotLabelWithContract,
  type FieldMappingRow,
} from '../utils/response-fields';

// --------------------------------------------------------------------------- #
// parseSourcePath — 与后端 parse_source 逐分支对齐
// --------------------------------------------------------------------------- #

describe('parseSourcePath — source 路径校验（与后端语义一致）', () => {
  it('合法：顶层 key / 数组行下标 / 点号路径 / 方括号下标 / 转义字面点', () => {
    expect(parseSourcePath('code')).toMatchObject({ status: 'ok', segmentCount: 1 });
    expect(parseSourcePath('0')).toMatchObject({ status: 'ok', segmentCount: 1 });
    expect(parseSourcePath('a.b')).toMatchObject({ status: 'ok', segmentCount: 2 });
    expect(parseSourcePath('items[0].code')).toMatchObject({ status: 'ok', segmentCount: 3 });
    // JSON 里写 "a\\.b"：字面含点 key，点号不分段
    expect(parseSourcePath('a\\.b')).toMatchObject({ status: 'ok', segmentCount: 1 });
    expect(parseSourcePath('[0].code')).toMatchObject({ status: 'ok', segmentCount: 2 });
    expect(parseSourcePath('data.list[2].price')).toMatchObject({ status: 'ok', segmentCount: 4 });
  });

  it('空串 = HEAD 语义（status=empty，不判非法路径）', () => {
    const r = parseSourcePath('');
    expect(r.status).toBe('empty');
    expect(r.message).toContain('HEAD');
  });

  it('非法：未闭合方括号 / 非数字下标 / 解析为空 / 段数超上限', () => {
    expect(parseSourcePath('items[0').status).toBe('invalid');
    expect(parseSourcePath('a[x]').message).toContain('非负整数');
    expect(parseSourcePath('.').status).toBe('invalid'); // 无任何段
    const six = parseSourcePath('a.b.c.d.e.f');
    expect(six.status).toBe('invalid');
    expect(six.message).toContain('6');
  });

  it('与后端一致：末尾孤立反斜杠按字面处理（不报错）；连续点号不产生空段', () => {
    expect(parseSourcePath('a\\').status).toBe('ok');
    expect(parseSourcePath('a..b')).toMatchObject({ status: 'ok', segmentCount: 2 });
  });
});

// --------------------------------------------------------------------------- #
// guessSlotForColumn — 预填猜测表
// --------------------------------------------------------------------------- #

describe('guessSlotForColumn — 按列名猜 slot', () => {
  it('中文列名：代码 / 名称 / 简称 / 最新价 / 收盘 / 日期', () => {
    expect(guessSlotForColumn('代码')).toBe('code');
    expect(guessSlotForColumn('名称')).toBe('name');
    expect(guessSlotForColumn('证券简称')).toBe('name');
    expect(guessSlotForColumn('最新价')).toBe('price');
    expect(guessSlotForColumn('收盘价')).toBe('price');
    expect(guessSlotForColumn('日期')).toBe('date');
  });

  it('英文列名（大小写不敏感）：market / exchange / date / trade_date', () => {
    expect(guessSlotForColumn('market')).toBe('exchange');
    expect(guessSlotForColumn('Exchange')).toBe('exchange');
    expect(guessSlotForColumn('date')).toBe('date');
    expect(guessSlotForColumn('trade_date')).toBe('date');
  });

  it('猜不中返回空串（仅展示）', () => {
    expect(guessSlotForColumn('备注')).toBe('');
    expect(guessSlotForColumn('')).toBe('');
  });
});

// --------------------------------------------------------------------------- #
// prefillRowsFromRaw — 一键预填
// --------------------------------------------------------------------------- #

describe('prefillRowsFromRaw — 从试调 raw 首行生成映射行', () => {
  it('dict 首行：逐 key 生成行并按猜测表填 slot / 默认 type', () => {
    const pre = prefillRowsFromRaw([
      { 代码: '600519', 名称: '贵州茅台', 最新价: 1688.0, market: 'sh', 日期: '2026-09-11', 备注: 'x' },
    ]);
    expect(pre.rows).toHaveLength(6);
    expect(pre.rows[0]).toMatchObject({ label: '代码', slot: 'code', source: '代码', type: 'string' });
    expect(pre.rows[1]).toMatchObject({ label: '名称', slot: 'name' });
    expect(pre.rows[2]).toMatchObject({ label: '最新价', slot: 'price', type: 'decimal' });
    expect(pre.rows[3]).toMatchObject({ label: 'market', slot: 'exchange' });
    expect(pre.rows[4]).toMatchObject({ label: '日期', slot: 'date', type: 'date' });
    expect(pre.rows[5]).toMatchObject({ label: '备注', slot: '' }); // 猜不中 = 仅展示
    expect(pre.warnings).toHaveLength(0);
  });

  it('数组首行：提示按位置下标填写（边界 8），不生成行', () => {
    const pre = prefillRowsFromRaw([['600519', '贵州茅台']]);
    expect(pre.rows).toHaveLength(0);
    expect(pre.warnings[0]).toContain('数组行');
    expect(pre.warnings[0]).toContain('位置下标');
  });

  it('识别 _code 特殊键并提示（边界 7）：text_split 行为注入 _code + 数字下标键的 dict', () => {
    const pre = prefillRowsFromRaw([{ _code: 'sh600519', 0: '600519', 1: '贵州茅台' }]);
    expect(pre.warnings.some((w) => w.includes('_code'))).toBe(true);
    // JS 对象整数键排在最前，_code 行位于其后
    const codeRow = pre.rows.find((r) => r.source === '_code');
    expect(codeRow).toBeTruthy();
  });

  it('标量首行（text_split 行）：提示按下标填写', () => {
    const pre = prefillRowsFromRaw(['600519']);
    expect(pre.rows).toHaveLength(0);
    expect(pre.warnings[0]).toContain('标量');
  });

  it('空数组 / null：给可读提示', () => {
    expect(prefillRowsFromRaw([]).warnings[0]).toContain('空数组');
    expect(prefillRowsFromRaw(null).warnings.length).toBeGreaterThan(0);
  });

  it('两列猜中同一 slot：后者置为仅展示并提示人工校正（slot 不可重复）', () => {
    const pre = prefillRowsFromRaw([{ 名称: 'a', 简称: 'b' }]);
    expect(pre.rows[0].slot).toBe('name');
    expect(pre.rows[1].slot).toBe('');
    expect(pre.warnings.some((w) => w.includes('name'))).toBe(true);
  });

  it('raw 为单层 dict：整体视作单行提取', () => {
    const pre = prefillRowsFromRaw({ 代码: '600519' });
    expect(pre.rows).toHaveLength(1);
    expect(pre.rows[0].slot).toBe('code');
  });
});

// --------------------------------------------------------------------------- #
// buildResponseFields — payload 组装（全空返回 null 约定）
// --------------------------------------------------------------------------- #

describe('buildResponseFields — 表单行 → ResponseFieldSpec[]', () => {
  it('全空（无行 / 全空白行）返回 null（既有约定）', () => {
    expect(buildResponseFields([])).toBeNull();
    expect(buildResponseFields([emptyFieldRow(), emptyFieldRow()])).toBeNull();
  });

  it('仅 label 的行也视为有意义；source 透传 trim', () => {
    const rows = [{ ...emptyFieldRow(), label: '公告标题' }];
    const specs = buildResponseFields(rows);
    expect(specs).not.toBeNull();
    expect(specs![0].source).toBe('');
    expect(specs![0].label).toBe('公告标题');
  });

  it('key 自动派生（中文列名回退 slot/source/label/fieldN）并保证唯一', () => {
    const rows: FieldMappingRow[] = [
      { ...emptyFieldRow(), key: 'code', source: '代码' },
      { ...emptyFieldRow(), key: 'code', source: '名称' }, // 重复 → code_2
      { ...emptyFieldRow(), label: '备注', source: 'remark' }, // 无 key → source 派生
      { ...emptyFieldRow(), label: '中文列', source: '中文' }, // 全派生失败 → fieldN
    ];
    const specs = buildResponseFields(rows)!;
    const keys = specs.map((s) => s.key);
    expect(keys[0]).toBe('code');
    expect(keys[1]).toBe('code_2');
    expect(keys[2]).toBe('remark');
    expect(keys[3]).toBe('field4');
    keys.forEach((k) => expect(isValidFieldKey(k)).toBe(true));
    // 接口内唯一
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('slot 空串 = 仅展示：不写入 slot（§5.2 不参与同步契约）', () => {
    const specs = buildResponseFields([{ ...emptyFieldRow(), source: 'title', label: '标题' }])!;
    expect(specs[0].slot).toBeUndefined();
    expect(specs[0].required).toBe(false);
  });

  it('scale 仅 decimal 且 0~8 携带；unit 仅非 none 携带；date_format 仅 date 携带', () => {
    const specs = buildResponseFields([
      { ...emptyFieldRow(), source: 'p', slot: 'price', type: 'decimal', scale: '2', unit: 'yuan' },
      { ...emptyFieldRow(), source: 'q', type: 'decimal', scale: '12' }, // 超范围 → 不带
      { ...emptyFieldRow(), source: 's', type: 'string', scale: '2' }, // 非 decimal → 不带
      { ...emptyFieldRow(), source: 'd', type: 'date', dateFormat: '%Y-%m-%d', unit: 'wan' },
    ])!;
    expect(specs[0]).toMatchObject({ scale: 2, unit: 'yuan' });
    expect(specs[1].scale).toBeUndefined();
    expect(specs[2].scale).toBeUndefined();
    expect(specs[3]).toMatchObject({ date_format: '%Y-%m-%d' });
    expect(specs[3].unit).toBe('wan'); // unit 为通用属性：非 none 即携带
  });
});

// --------------------------------------------------------------------------- #
// 编辑回填：fieldRowsFromSpecs / fieldRowsFromLegacyColumns
// --------------------------------------------------------------------------- #

describe('编辑回填', () => {
  it('fieldRowsFromSpecs：slot null/缺省 → 仅展示；scale 回填为字符串', () => {
    const specs: ResponseFieldSpec[] = [
      { key: 'code', slot: 'code', source: 'code', type: 'string', required: true },
      { key: 'price', slot: 'price', source: 'data.last', type: 'decimal', scale: 2, unit: 'yuan' },
      { key: 'title', source: 'title' }, // 无 slot = 仅展示
      { key: 'd', slot: 'date', source: 'trade_date', type: 'date', date_format: '%Y%m%d' },
    ];
    const rows = fieldRowsFromSpecs(specs);
    expect(rows[0]).toMatchObject({ slot: 'code', required: true, scale: '' });
    expect(rows[1]).toMatchObject({ slot: 'price', scale: '2', unit: 'yuan' });
    expect(rows[2].slot).toBe('');
    expect(rows[3]).toMatchObject({ dateFormat: '%Y%m%d' });
  });

  it('fieldRowsFromLegacyColumns：镜像后端 fold_legacy_columns（默认值 + 可选槽）', () => {
    const rows = fieldRowsFromLegacyColumns({
      categoryId: '1',
      respCodeField: 'security_code',
      respPriceField: null,
      respNameField: null,
      respExchangeField: 'exchange',
      respDateField: null,
    });
    expect(rows).toHaveLength(4); // code/name/price 恒产出 + exchange 显式
    expect(rows[0]).toMatchObject({ key: 'code', slot: 'code', source: 'security_code' });
    expect(rows[1]).toMatchObject({ key: 'name', slot: 'name', source: 'name' }); // 模型默认值
    expect(rows[2]).toMatchObject({ key: 'price', slot: 'price', source: 'price', type: 'decimal' });
    expect(rows[3]).toMatchObject({ key: 'exchange', slot: 'exchange', source: 'exchange' });
  });

  it('fieldRowsFromLegacyColumns：分红/公告用途（分类 3/4）code 占位替换为中文列名兜底', () => {
    for (const cat of ['3', '4']) {
      const rows = fieldRowsFromLegacyColumns({
        categoryId: cat,
        respCodeField: 'code',
        respPriceField: null,
        respNameField: null,
        respExchangeField: null,
        respDateField: null,
      });
      expect(rows[0].source).toBe('代码');
    }
    // 其他分类保持 code
    const rows1 = fieldRowsFromLegacyColumns({
      categoryId: '1',
      respCodeField: 'code',
      respPriceField: null,
      respNameField: null,
      respExchangeField: null,
      respDateField: null,
    });
    expect(rows1[0].source).toBe('code');
  });

  it('fieldRowsFromLegacyColumns：分类 3/4 且 respCodeField 为自定义列名时原样保留（D1 缺陷回归）', () => {
    // 后端 fold_legacy_columns 仅当源为字面 "code" 才替换为「代码」；自定义列名
    // （如 security_code）必须保留，否则保存后 derive_legacy_columns 会静默覆写。
    for (const cat of ['3', '4']) {
      const rows = fieldRowsFromLegacyColumns({
        categoryId: cat,
        respCodeField: 'security_code',
        respPriceField: null,
        respNameField: null,
        respExchangeField: null,
        respDateField: null,
      });
      expect(rows[0].source).toBe('security_code');
    }
  });

  it('fieldRowsFromLegacyColumns：分类 1/2 及无分类时自定义 code 列名恒原样保留', () => {
    for (const cat of ['1', '2', null]) {
      const rows = fieldRowsFromLegacyColumns({
        categoryId: cat,
        respCodeField: 'security_code',
        respPriceField: null,
        respNameField: null,
        respExchangeField: null,
        respDateField: null,
      });
      expect(rows[0].source).toBe('security_code');
    }
  });

  it('fieldRowsFromLegacyColumns：respCodeField 空串/null 先取默认 "code"，再按分类判断替换', () => {
    // 与后端 resp_code_field or "code" 一致：先补默认值，再进入 3/4 分类替换规则
    for (const cat of ['3', '4']) {
      for (const empty of ['', null]) {
        const rows = fieldRowsFromLegacyColumns({
          categoryId: cat,
          respCodeField: empty,
          respPriceField: null,
          respNameField: null,
          respExchangeField: null,
          respDateField: null,
        });
        expect(rows[0].source).toBe('代码');
      }
    }
    for (const empty of ['', null]) {
      const rows = fieldRowsFromLegacyColumns({
        categoryId: '1',
        respCodeField: empty,
        respPriceField: null,
        respNameField: null,
        respExchangeField: null,
        respDateField: null,
      });
      expect(rows[0].source).toBe('code');
    }
  });

  it('fieldRowsFromLegacyColumns：resp_date_field 显式提供时产出 date 行', () => {
    const rows = fieldRowsFromLegacyColumns({
      categoryId: '2',
      respCodeField: 'code',
      respPriceField: 'price',
      respNameField: null,
      respExchangeField: null,
      respDateField: 'kline_day.date',
    });
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ key: 'date', slot: 'date', source: 'kline_day.date', type: 'date' });
  });
});

// --------------------------------------------------------------------------- #
// missingRequiredSlots — 按契约端点检查分类必填
// --------------------------------------------------------------------------- #

describe('missingRequiredSlots — 按分类契约检查缺必填槽', () => {
  const schema: ResponseFieldSchema = {
    slots: [
      { value: 'code', label: '证券代码', requiredFor: ['1', '2', '3', '4'] },
      { value: 'price', label: '价格 / 收盘价', requiredFor: ['2'] },
      { value: 'date', label: '日期', requiredFor: ['2'] },
    ],
    types: ['string', 'number', 'decimal', 'date', 'bool'],
    units: ['none', 'yuan', 'wan', 'pct'],
    contracts: {
      '1': { required: ['code'], optional: ['name', 'exchange', 'price', 'date'] },
      '2': { required: ['code', 'price', 'date'], optional: ['name', 'exchange'] },
    },
  };

  it('行情分类（2）缺 price/date 时全部列出', () => {
    const rows = fieldRowsFromSpecs([{ key: 'code', slot: 'code', source: 'code' }]);
    expect(missingRequiredSlots(rows, schema, '2')).toEqual(['price', 'date']);
  });

  it('补齐后清零；无契约的分类（未列出 id）恒为空', () => {
    const rows = fieldRowsFromSpecs([
      { key: 'code', slot: 'code', source: 'code' },
      { key: 'price', slot: 'price', source: 'price', type: 'decimal' },
      { key: 'd', slot: 'date', source: 'date', type: 'date' },
    ]);
    expect(missingRequiredSlots(rows, schema, '2')).toEqual([]);
    expect(missingRequiredSlots(rows, schema, '9')).toEqual([]);
  });

  it('仅展示字段不参与契约（§5.2）；schema 未加载时恒为空', () => {
    const rows = fieldRowsFromSpecs([{ key: 't', source: 'title' }]);
    expect(missingRequiredSlots(rows, schema, '2')).toEqual(['code', 'price', 'date']);
    expect(missingRequiredSlots(rows, null, '2')).toEqual([]);
  });

  it('slotLabelWithContract：契约必填槽位加 *，非必填不加', () => {
    const required = ['code', 'price', 'date'];
    expect(slotLabelWithContract('code', '证券代码', required)).toBe('证券代码 *');
    expect(slotLabelWithContract('name', '证券名称', required)).toBe('证券名称');
  });
});
