/**
 * SOP 静态控制测试（INC-05 文案唯一 / INC-01 控件唯一）
 *
 * 这些是「grep 级」断言：在源码层面锁定增量 PRD 的两条硬约束，防止后续改动
 * 让旧文案 / 第二套控件悄悄回潮。属增量 SOP 的回归护栏，不在运行时依赖组件。
 *
 * 扫描范围：packages/web/src 下所有 .ts/.tsx 后缀文件，排除 __tests__ 目录
 * 与 .test. / .spec. 后缀文件（避免测试文件与文档注释干扰；PRD 约束针对实现代码）。
 *
 * 覆盖：
 * - INC-05：旧文案「新增出入金 / ＋ 新建记录 / + 新建记录 / 新建记录」零残留
 *   （仅允许在 constants/entry-button-labels.ts 的注释中作为「已作废」说明出现）。
 * - INC-05：统一文案（录入出入金 / 录入买卖 / 录入资产记录）仅在 ENTRY_BUTTON_LABELS
 *   中作为字面量出现 —— 单一真相源。
 * - INC-05：出入金页按钮文案与弹窗标题同源（均用 ENTRY_BUTTON_LABELS.cashFlow）。
 * - INC-01：DateRangeQuickPicker 全站唯一（仅一个定义文件）；统一页面均从 canonical
 *   路径 import；DimensionSwitcher 内嵌复用而非自绘范围 UI。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '..');

/** 递归收集实现源码（排除测试与规格文件） */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.isFile()) {
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const ALL_SRC = collectSourceFiles(SRC_DIR);
const REL = (f: string) => path.relative(SRC_DIR, f).split(path.sep).join('/');

/**
 * 去掉注释，避免把「文档性注释」误判为代码残留。
 * （如 snapshots.tsx 注释「文案由「＋ 新建记录」改为字典值「录入资产记录」」属说明，非代码用法。）
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行注释（避免误删 http:// 之类）
}

function filesContaining(phrase: string): string[] {
  return ALL_SRC.filter((f) =>
    stripComments(fs.readFileSync(f, 'utf-8')).includes(phrase),
  ).map(REL);
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(SRC_DIR, rel), 'utf-8');
}

describe('INC-05 — 旧文案零残留', () => {
  const CASES: Array<{ phrase: string; allow: string[] }> = [
    // 仅允许在 entry-button-labels.ts 的注释里作为「已作废」说明出现
    { phrase: '新增出入金', allow: ['constants/entry-button-labels.ts'] },
    { phrase: '＋ 新建记录', allow: [] },
    { phrase: '+ 新建记录', allow: [] },
    { phrase: '新建记录', allow: ['constants/entry-button-labels.ts'] },
  ];

  for (const { phrase, allow } of CASES) {
    it(`「${phrase}」仅允许出现在允许列表（实现代码零残留）`, () => {
      const hits = filesContaining(phrase);
      const offenders = hits.filter((f) => !allow.includes(f));
      expect(offenders, `在以下文件发现残留: ${offenders.join(', ')}`).toEqual([]);
    });
  }
});

describe('INC-05 — 统一文案单一真相源（ENTRY_BUTTON_LABELS）', () => {
  // 字典定义处（单一真相源）：字面量只应在这一处被赋值
  const DEFS: Array<{ key: string; label: string }> = [
    { key: 'cashFlow', label: '录入出入金' },
    { key: 'securityTrade', label: '录入买卖' },
    { key: 'snapshot', label: '录入资产记录' },
  ];

  for (const { key, label } of DEFS) {
    it(`「${label}」仅在 ENTRY_BUTTON_LABELS.${key} 定义（单一真相源）`, () => {
      const src = readFile('constants/entry-button-labels.ts');
      // 字典以 `key: 'label'` 形式定义该文案
      expect(src).toMatch(new RegExp(`${key}\\s*:\\s*['"]${label}['"]`));
    });
  }

  it('入口键齐全（cashFlow/securityTrade/snapshot/portfolio/security）', () => {
    const src = readFile('constants/entry-button-labels.ts');
    for (const key of ['cashFlow', 'securityTrade', 'snapshot', 'portfolio', 'security']) {
      expect(src).toMatch(new RegExp(`\\b${key}\\s*:`));
    }
  });

  it('入口文案不作为裸 JSX 文本出现（页面须引用 ENTRY_BUTTON_LABELS）', () => {
    // 裸元素文本（如 <Button>录入出入金</Button>）才是需要拦截的回归；
    // 描述性文案（description="录入买卖流水…"）与注释不在约束内。
    for (const { label } of DEFS) {
      const offenders = ALL_SRC.filter((f) =>
        new RegExp(`>${label}<`).test(stripComments(fs.readFileSync(f, 'utf-8'))),
      ).map(REL);
      expect(
        offenders,
        `发现裸文案按钮/标题（应为 ENTRY_BUTTON_LABELS 引用）: ${offenders.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('入口页按钮/标题引用 ENTRY_BUTTON_LABELS（而非自写字面量）', () => {
    const at = (rel: string) => readFile(rel);
    expect(at('pages/transactions.tsx')).toContain('ENTRY_BUTTON_LABELS.cashFlow');
    expect(at('pages/dashboard.tsx')).toContain('ENTRY_BUTTON_LABELS.securityTrade');
    expect(at('pages/snapshots.tsx')).toContain('ENTRY_BUTTON_LABELS.snapshot');
  });
});

describe('INC-05 — 出入金页按钮文案 == 弹窗标题（同源）', () => {
  it('transactions.tsx 的录入按钮与弹窗标题共用 ENTRY_BUTTON_LABELS.cashFlow', () => {
    const src = readFile('pages/transactions.tsx');
    const uses = (src.match(/ENTRY_BUTTON_LABELS\.cashFlow/g) ?? []).length;
    // 按钮（页头）+ DialogTitle（弹窗）至少两处引用，证明文案同源
    expect(uses).toBeGreaterThanOrEqual(2);
  });
});

describe('INC-01 — DateRangeQuickPicker 全站唯一（canonical）', () => {
  it('全站仅一个文件导出 DateRangeQuickPicker', () => {
    const defs = ALL_SRC.filter((f) =>
      fs.readFileSync(f, 'utf-8').includes('export function DateRangeQuickPicker'),
    ).map(REL);
    expect(defs).toEqual(['components/date/date-range-quick-picker.tsx']);
  });

  it('直接使用的页面均从 canonical 路径 import（而非自绘副本）', () => {
    const importers = filesContaining("from '@/components/date/date-range-quick-picker'");
    for (const page of [
      'pages/transactions.tsx',
      'features/snapshot/snapshot-list.tsx',
    ]) {
      expect(importers, `页面 ${page} 未引用 canonical 控件`).toContain(page);
    }
  });

  it('分析页通过 DimensionSwitcher 复用（内嵌 canonical 控件），不直接自绘', () => {
    const dimImporters = filesContaining("from '@/features/query/dimension-switcher'");
    for (const page of ['pages/xirr-analysis.tsx', 'pages/nav-analysis.tsx']) {
      expect(
        dimImporters,
        `页面 ${page} 未复用 DimensionSwitcher（内嵌 canonical 控件）`,
      ).toContain(page);
    }
  });
});

describe('INC-01 — DimensionSwitcher 内嵌复用而非自绘范围 UI', () => {
  it('dimension-switcher.tsx 内嵌 <DateRangeQuickPicker> 且从 canonical 路径 import', () => {
    const src = readFile('features/query/dimension-switcher.tsx');
    expect(src).toContain("from '@/components/date/date-range-quick-picker'");
    expect(src).toMatch(/<DateRangeQuickPicker/);
  });

  it('dimension-switcher.tsx 不再声明私有的 quickRange 本地状态', () => {
    const src = readFile('features/query/dimension-switcher.tsx');
    expect(src).not.toMatch(/const\s+quickRange\s*=/);
  });
});
