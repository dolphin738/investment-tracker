/**
 * modules/admin/__tests__/interface-category-icon-picker.test.ts
 *
 * 回归验证：改动 B — 图标框改可搜索下拉选择器（InterfaceCategoryIconPicker）
 *
 * 验收点：
 * 1. 初始（空值）：触发器文案「选择图标」、无清空按钮。
 * 2. 打开面板后出现搜索框 + 图标网格；点击首个图标 → emit update:modelValue
 *    等于该图标 PascalCase 名；选中后面板关闭。
 * 3. 搜索过滤：输入「list」后仅出现含 list 的图标（证明 SearchInput v-model 联动
 *    filteredNames）；点击选中 emit 正确名。
 * 4. 已选值时显示清空按钮；点击清空 → emit update:modelValue('')。
 *
 * 组件内部直接渲染 lucide 全量注册表（icons），不依赖 portal，故全部在 wrapper 内查询。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import InterfaceCategoryIconPicker from '../components/InterfaceCategoryIconPicker.vue';
import { installJsdomPolyfills } from '@/test-utils/jsdom-polyfills';

let wrapper: VueWrapper | null = null;

function build(modelValue = ''): VueWrapper {
  wrapper = mount(InterfaceCategoryIconPicker, {
    props: { modelValue, id: 'cat-icon' },
    attachTo: document.body,
  });
  return wrapper;
}

/** 触发器：带 id=cat-icon 的 Button */
function triggerBtn(): VueWrapper['find'] extends never ? never : ReturnType<VueWrapper['find']> {
  return wrapper!.find('#cat-icon');
}

async function openPanel(): Promise<void> {
  await wrapper!.find('#cat-icon').trigger('click');
  await flushPromises();
  await nextTick();
}

/** 面板内的图标按钮（带 title=图标名） */
function iconButtons(): ReturnType<VueWrapper['findAll']> {
  return wrapper!.findAll('button[title]');
}

beforeEach(() => {
  installJsdomPolyfills();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('InterfaceCategoryIconPicker — 改动 B 可搜索图标选择器', () => {
  it('① 初始（空值）：显示「选择图标」、无清空按钮', () => {
    build('');
    expect(wrapper!.text()).toContain('选择图标');
    expect(wrapper!.find('[aria-label="清空图标"]').exists()).toBe(false);
  });

  it('② 打开面板后出现搜索框与图标网格；点击首个图标 emit 其名，并关闭面板', async () => {
    build('');
    await openPanel();

    // 面板渲染：搜索输入框存在
    expect(wrapper!.find('input').exists()).toBe(true);

    const btns = iconButtons();
    expect(btns.length).toBeGreaterThan(0);

    // 首个图标按钮的 title 即 PascalCase 图标名
    const first = btns[0];
    const name = first.attributes('title');
    expect(name).toBeTruthy();
    expect(name!.length).toBeGreaterThan(0);

    await first.trigger('click');
    await flushPromises();

    const emitted = wrapper!.emitted('update:modelValue');
    expect(emitted).toBeTruthy();
    expect(emitted!.at(-1)).toEqual([name]);

    // 选中后面板关闭（搜索框不再存在）
    expect(wrapper!.find('input').exists()).toBe(false);
  });

  it('③ 搜索过滤：输入「list」后仅出现含 list 的图标，点击选中 emit 正确名', async () => {
    build('');
    await openPanel();

    const input = wrapper!.find('input');
    await input.setValue('list');
    await flushPromises();
    await nextTick();

    const titles = iconButtons().map((b) => b.attributes('title')!);
    expect(titles.length).toBeGreaterThan(0);
    // 过滤生效：所有可见项均包含 "list"（不区分大小写）
    expect(titles.every((t) => t.toLowerCase().includes('list'))).toBe(true);

    // 点击目标（优先 "List"，否则首个）；断言 emit 值为其名
    const listBtn = iconButtons().find((b) => b.attributes('title') === 'List');
    const target = (listBtn ?? iconButtons()[0]) as ReturnType<VueWrapper['findAll']>[number];
    const tname = target.attributes('title')!;
    await target.trigger('click');
    await flushPromises();

    expect(wrapper!.emitted('update:modelValue')!.at(-1)).toEqual([tname]);
  });

  it('④ 已选值时显示清空按钮；点击清空 emit 空串', async () => {
    build('Home');

    // 触发器回显已选图标名
    expect(wrapper!.text()).toContain('Home');

    const clearBtn = wrapper!.find('[aria-label="清空图标"]');
    expect(clearBtn.exists()).toBe(true);

    await clearBtn.trigger('click');
    await flushPromises();

    const emitted = wrapper!.emitted('update:modelValue');
    expect(emitted).toBeTruthy();
    expect(emitted!.at(-1)).toEqual(['']);
  });
});
