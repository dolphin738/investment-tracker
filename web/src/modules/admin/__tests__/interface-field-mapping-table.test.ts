/**
 * modules/admin/__tests__/interface-field-mapping-table.test.ts
 *
 * InterfaceFieldMappingTable 组件单测（方案 §7 抽出的字段映射表格）：
 * 1. slot 下拉选项来自契约 schema（不硬编码），契约必填槽位在选项文案打 *
 * 2. 表头按 contracts[categoryId] 显式标注当前分类必填
 * 3. source 实时校验提示（合法不报错 / 非法给原因）
 * 4. 增 / 删 / 改行全部通过 emit 回传父级（行对象不在组件内持有）
 * 5. 「高级」展开区按类型条件渲染（scale 仅 decimal、date_format 仅 date）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { ResponseFieldSchema } from '@/api/quote-interface.api';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';
import InterfaceFieldMappingTable from '../components/InterfaceFieldMappingTable.vue';
import { emptyFieldRow, type FieldMappingRow } from '../utils/response-fields';

const SCHEMA: ResponseFieldSchema = {
  slots: [
    { value: 'code', label: '证券代码', requiredFor: ['1', '2', '3', '4'] },
    { value: 'price', label: '价格 / 收盘价', requiredFor: ['2'] },
    { value: 'name', label: '证券名称', requiredFor: [] },
  ],
  types: ['string', 'number', 'decimal', 'date', 'bool'],
  units: ['none', 'yuan', 'wan', 'pct'],
  contracts: {
    '1': { required: ['code'], optional: ['name', 'exchange', 'price', 'date'] },
    '2': { required: ['code', 'price', 'date'], optional: ['name', 'exchange'] },
  },
};

let wrapper: VueWrapper | null = null;

function mountTable(rows: FieldMappingRow[], categoryId = '1', schema: ResponseFieldSchema | null = SCHEMA) {
  return mount(InterfaceFieldMappingTable, {
    props: { rows, schema, categoryId },
    attachTo: document.body,
  });
}

beforeEach(() => {
  installJsdomPolyfills();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('InterfaceFieldMappingTable — 契约驱动的渲染', () => {
  it('表头标注当前分类必填槽位说明（契约 2 有 3 个必填槽）', () => {
    wrapper = mountTable([emptyFieldRow()], '2');
    expect(wrapper.text()).toContain('为当前分类必填');
  });

  it('slot 下拉由 schema 驱动：加载完成后可选、未加载时禁用（选项星标见 slotLabelWithContract 单测）', () => {
    wrapper = mountTable([{ ...emptyFieldRow(), source: 'code' }], '1');
    const triggers = document.body.querySelectorAll('button[role="combobox"]');
    expect(triggers.length).toBeGreaterThanOrEqual(2); // slot 下拉 + 类型下拉
    triggers.forEach((t) => expect((t as HTMLButtonElement).disabled).toBe(false));
  });

  it('schema 为 null（加载中）时下拉禁用并显示加载占位', () => {
    wrapper = mountTable([emptyFieldRow()], '1', null);
    const trigger = document.body.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(wrapper.text()).toContain('加载契约中…');
  });
});

describe('InterfaceFieldMappingTable — source 实时校验提示', () => {
  /** source 输入框下方的校验提示（仅 status != ok 时渲染） */
  const sourceHint = (w: VueWrapper) => w.find('p.mt-0\\.5');

  it('合法路径不渲染校验提示', () => {
    wrapper = mountTable([{ ...emptyFieldRow(), source: 'items[0].code' }], '1');
    expect(sourceHint(wrapper).exists()).toBe(false);
  });

  it('非法路径显示原因（未闭合方括号），且为 destructive 色', () => {
    wrapper = mountTable([{ ...emptyFieldRow(), source: 'items[0' }], '1');
    const hint = sourceHint(wrapper);
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain("']'");
    expect(hint.classes()).toContain('text-destructive');
  });

  it('空串给 HEAD 语义提示（非 destructive 色）', () => {
    wrapper = mountTable([emptyFieldRow()], '1');
    const hint = sourceHint(wrapper);
    expect(hint.text()).toContain('HEAD');
    expect(hint.classes()).not.toContain('text-destructive');
  });
});

describe('InterfaceFieldMappingTable — 增删改 emit 契约', () => {
  it('点击「添加字段」emit addRow；点击删除 emit removeRow(idx)', async () => {
    wrapper = mountTable([{ ...emptyFieldRow(), source: 'code' }], '1');
    await wrapper.find('button[aria-label="删除字段行"]').trigger('click');
    expect(wrapper.emitted('removeRow')![0]).toEqual([0]);

    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加字段'))!;
    await addBtn.trigger('click');
    expect(wrapper.emitted('addRow')).toHaveLength(1);
  });

  it('修改 source 输入框 emit updateRow(idx, {source})；点击高级 emit 展开态', async () => {
    wrapper = mountTable([{ ...emptyFieldRow(), source: 'code' }], '1');
    const inputs = document.body.querySelectorAll('input[placeholder*="取值路径"]');
    const sourceInput = inputs[0] as HTMLInputElement;
    sourceInput.value = 'a.b';
    sourceInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('updateRow')![0]).toEqual([0, { source: 'a.b' }]);

    await wrapper.find('button[aria-label="展开高级设置"]').trigger('click');
    expect(wrapper.emitted('updateRow')![1]).toEqual([0, { advancedOpen: true }]);
  });

  it('高级展开区按类型条件渲染：decimal 显小数位、date 显日期格式、string 两者皆无', async () => {
    wrapper = mountTable(
      [
        { ...emptyFieldRow(), source: 'p', type: 'decimal', advancedOpen: true },
        { ...emptyFieldRow(), source: 'd', type: 'date', advancedOpen: true },
        { ...emptyFieldRow(), source: 's', type: 'string', advancedOpen: true },
      ],
      '1',
    );
    const text = wrapper.text();
    expect(text).toContain('小数位（0~8）');
    expect(text).toContain('日期格式');
    // 三个展开区共 2 处专属控件标签；string 行只有 key / 单位
    expect(wrapper.findAll('label').filter((l) => l.text().includes('小数位'))).toHaveLength(1);
    expect(wrapper.findAll('label').filter((l) => l.text().includes('日期格式'))).toHaveLength(1);
  });

  it('空行列表显示空态文案', () => {
    wrapper = mountTable([], '1');
    expect(wrapper.text()).toContain('暂无字段映射');
  });
});
