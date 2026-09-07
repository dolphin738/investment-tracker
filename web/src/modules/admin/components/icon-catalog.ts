/**
 * modules/admin/components/icon-catalog.ts — 接口分类图标分组目录 + 默认图标推断
 *
 * 背景：lucide-vue-next 全量约 1500 个图标，无运行时语义分组元数据。
 * 接口分类管理场景下只需「分类即用途」相关的常用图标，故在此维护一份
 * 精选分组目录（语义分组），供 InterfaceCategoryIconPicker 分组展示。
 * 同时提供 inferDefaultIcon，新建分类时按名称关键词自动选出默认图标。
 */

/** 图标分组：每组一个中文组名 + 该组 lucide 图标名（PascalCase） */
export interface IconGroup {
  label: string;
  icons: string[];
}

export const ICON_GROUPS: IconGroup[] = [
  {
    label: '通用',
    icons: [
      'List',
      'ListOrdered',
      'LayoutList',
      'ListChecks',
      'Tag',
      'Tags',
      'Hash',
      'Folder',
      'FolderOpen',
      'Bookmark',
      'Layers',
      'Box',
    ],
  },
  {
    label: '数据图表',
    icons: [
      'BarChart',
      'BarChart2',
      'BarChart3',
      'BarChart4',
      'LineChart',
      'PieChart',
      'AreaChart',
      'TrendingUp',
      'TrendingDown',
      'Activity',
      'Gauge',
      'GitGraph',
      'CandlestickChart',
    ],
  },
  {
    label: '金融货币',
    icons: [
      'DollarSign',
      'Coins',
      'Banknote',
      'CreditCard',
      'Wallet',
      'Landmark',
      'PiggyBank',
      'Receipt',
      'BadgeDollarSign',
      'CircleDollarSign',
      'ScrollText',
      'Bitcoin',
    ],
  },
  {
    label: '新闻公告',
    icons: [
      'Megaphone',
      'Newspaper',
      'Rss',
      'Bell',
      'BellRing',
      'Mail',
      'MessageSquare',
      'FileText',
      'FileSpreadsheet',
      'ClipboardList',
      'Inbox',
      'Send',
    ],
  },
  {
    label: '编辑操作',
    icons: [
      'Settings',
      'Settings2',
      'Cog',
      'SlidersHorizontal',
      'Wrench',
      'Plus',
      'Pencil',
      'Bot',
      'Package',
      'Boxes',
      'Zap',
      'Globe',
      'Building2',
      'Store',
      'Network',
      'Share2',
      'ArrowRightLeft',
      'Repeat',
    ],
  },
];

/** 关键词 → 默认图标名 的推断规则（按数组顺序命中首个） */
const INFER_RULES: Array<{ keywords: string[]; icon: string }> = [
  { keywords: ['行情', '价格', '实时', 'quote', 'price'], icon: 'LineChart' },
  { keywords: ['列表', '主数据', 'list', 'master'], icon: 'List' },
  { keywords: ['公告', '新闻', 'notice', 'news'], icon: 'Megaphone' },
  { keywords: ['股息', '分红', 'dividend'], icon: 'Coins' },
  { keywords: ['基金', 'fund'], icon: 'Landmark' },
  { keywords: ['债券', 'bond'], icon: 'FileText' },
  { keywords: ['指数', 'index'], icon: 'BarChart3' },
  { keywords: ['期货', 'future'], icon: 'Activity' },
  { keywords: ['外汇', '汇率', 'forex'], icon: 'ArrowRightLeft' },
  { keywords: ['加密', '比特', 'crypto'], icon: 'Bitcoin' },
  { keywords: ['钱包', '账户', 'wallet'], icon: 'Wallet' },
  { keywords: ['配置', '设置', 'setting'], icon: 'Settings2' },
];

/**
 * 按分类名称推断默认图标。
 * 命中关键词返回对应 lucide 图标名；无命中返回空串（交由用户手动选择）。
 */
export function inferDefaultIcon(label: string): string {
  const text = label.trim().toLowerCase();
  if (!text) return '';
  for (const rule of INFER_RULES) {
    if (rule.keywords.some((k) => text.includes(k.toLowerCase()))) {
      return rule.icon;
    }
  }
  return '';
}
