/**
 * constants/entry-button-labels.ts — 录入类按钮文案 / 视觉规格字典（INC-05 · 决策 H）
 *
 * 【决策 H：同功能按钮文案唯一】
 * 同一个功能在概览页、列表页、空态、引导卡、弹窗标题里必须用**同一句文案**，
 * 不允许出现「新增出入金 / 录入出入金」「＋ 新建记录 / 录入资产记录」这类同义漂移。
 * 所有录入入口一律从本字典取值，禁止在页面里写字面量。
 *
 * 【拍板结果（PRD v1.2 Q-H1~Q-H5 / Q-G1）】
 * - 出入金：统一「录入出入金」（原「新增出入金」作废）
 * - 证券买卖：统一「录入买卖」（概览页原文案为准，不拆分买/卖两个按钮）
 * - 资产记录：统一「录入资产记录」（原「＋ 新建记录」作废；文案里不再带字面「+」，
 *   加号语义由 `Plus` 图标承载）
 * - 组合：保持「新建组合」（文案不改，仅统一按钮样式）
 * - 标的：保持「新建标的」（下拉内联入口，文案不改）
 *
 * 【视觉规格（INC-05）】
 * 录入类主按钮 = 概览页「录入买卖」的样式：`variant="default"`（主色）+ `size="sm"`
 * + 前置 `Plus` 图标。空态（EmptyState）内的按钮**尺寸豁免**（可用默认尺寸以获得
 * 更大点击热区），但 variant 与图标仍须一致。
 */

/** 录入 / 新建类入口的统一文案（决策 H：同功能文案唯一） */
export const ENTRY_BUTTON_LABELS = {
  /** 出入金录入（页头按钮 / 空态按钮 / 引导卡 / 弹窗标题共用） */
  cashFlow: '录入出入金',
  /** 现金余额录入（出入金页「现金余额」页签按钮 / 新增与编辑弹窗标题共用） */
  cashBalance: '录入现金余额',
  /** 证券买卖录入（页头按钮 / 空态按钮 / 引导卡 / 弹窗标题共用） */
  securityTrade: '录入买卖',
  /** 资产记录（历史总资产）录入 */
  snapshot: '录入资产记录',
  /** 新建投资组合（文案不改，仅统一样式） */
  portfolio: '新建组合',
  /** 新建标的（标的下拉内联入口，文案不改） */
  security: '新建标的',
} as const;

/** 录入按钮键名（供类型约束，避免拼写漂移） */
export type EntryButtonKey = keyof typeof ENTRY_BUTTON_LABELS;

/**
 * 录入类主按钮统一尺寸（INC-05）。
 *
 * 对齐概览页「录入买卖」：`size="sm"`。
 * 🔴 空态按钮豁免此常量（见文件头说明），但仍须使用 {@link ENTRY_BUTTON_VARIANT}。
 */
export const ENTRY_BUTTON_SIZE = 'sm' as const;

/** 录入类主按钮统一 variant（INC-05）：主色实心，空态同样适用 */
export const ENTRY_BUTTON_VARIANT = 'default' as const;

/**
 * 录入按钮图标统一间距类名。
 *
 * `size="sm"` 与默认尺寸下 `mr-2 h-4 w-4` 观感一致，集中一处便于后续统一调整。
 */
export const ENTRY_BUTTON_ICON_CLASS = 'mr-2 h-4 w-4';
