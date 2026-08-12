/**
 * pages/admin.tsx — 系统管理页（仅管理员可见）
 *
 * 通用外壳：左侧分组导航注册表（ADMIN_NAV）。
 *
 * 导航结构（二级分组，支持展开/收起）：
 *   系统管理
 *     └─ 金融数据接口（group，可展开/收起）
 *          ├─ 接口API来源   （quote-provider，原「证券行情设置」）
 *          └─ 接口分类管理   （interface-category）
 *
 * - AdminNav 是 AdminGroup 与 AdminSection 的联合类型：group 拥有 children，
 *   leaf 直接持有 component。新增管理板块只需在对应 group 下追加一条 children 注册项，
 *   不改外壳（PRD P0-1/P0-2）。
 * - 非管理员：整页「无权限访问该页面」，且左栏/板块均不渲染。
 * - 管理员：左侧栏「金融数据接口」为可展开/收起的二级菜单（点击标题切换展开状态，
 *   带 Chevron 指示）；其下两个子模块即「分页」单元。右栏顶部另设分页 tab 控件，
 *   与左栏点击切换共享同一 active 状态，点击即在右栏渲染对应内容。
 * - 默认选中第一个叶子板块（quote-provider）；findActive 按 key 在 group children 中检索，
 *   未命中则回退到第一个叶子板块。
 */

import { useState } from 'react';
import { Database, ServerCog, Tags, ChevronRight, ChevronDown } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useIsAdmin } from '@/stores/auth.store';
import { QuoteProviderSection } from '@/features/admin/quote-provider-section';
import { InterfaceCategorySection } from '@/features/admin/interface-category-section';

interface AdminSection {
  key: string;
  label: string;
  icon: JSX.Element;
  component: () => JSX.Element;
}

interface AdminGroup {
  key: string;
  label: string;
  icon: JSX.Element;
  children: AdminSection[];
}

type AdminNav = AdminGroup | AdminSection;

const ADMIN_NAV: AdminNav[] = [
  {
    key: 'financial-data-interface',
    label: '金融数据接口',
    icon: <Database className="mr-2 h-4 w-4" />,
    children: [
      {
        key: 'quote-provider',
        label: '接口API来源',
        icon: <ServerCog className="mr-2 h-4 w-4" />,
        component: QuoteProviderSection,
      },
      {
        key: 'interface-category',
        label: '接口分类管理',
        icon: <Tags className="mr-2 h-4 w-4" />,
        component: InterfaceCategorySection,
      },
    ],
  },
];

/** 取导航中第一个叶子板块（用于默认选中与回退）。 */
function getFirstLeaf(): AdminSection {
  const first = ADMIN_NAV[0];
  return 'children' in first ? first.children[0] : first;
}

/** 按 key 在 group children 中检索对应 leaf；未命中则回退到第一个叶子板块。 */
function findActive(key: string): AdminSection {
  for (const nav of ADMIN_NAV) {
    if ('children' in nav) {
      const found = nav.children.find((child) => child.key === key);
      if (found) return found;
    } else if (nav.key === key) {
      return nav;
    }
  }
  return getFirstLeaf();
}

export default function AdminPage(): JSX.Element {
  const isAdmin = useIsAdmin();
  const [active, setActive] = useState<string>(getFirstLeaf().key);
  const [expanded, setExpanded] = useState<boolean>(true);

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">系统管理</h1>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            无权限访问该页面
          </CardContent>
        </Card>
      </div>
    );
  }

  const Active = findActive(active).component;
  const leaves = ADMIN_NAV.flatMap((nav) =>
    'children' in nav ? nav.children : [nav],
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">系统管理</h1>
      <div className="flex gap-6">
        <nav className="w-56 shrink-0 border-r pr-3">
          {ADMIN_NAV.map((nav) => {
            if ('children' in nav) {
              return (
                <div key={nav.key} className="mb-4">
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                  >
                    <span className="flex items-center">
                      {nav.icon}
                      {nav.label}
                    </span>
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0" />
                    )}
                  </button>
                  {expanded && (
                    <div className="ml-2 border-l pl-2">
                      {nav.children.map((child) => (
                        <button
                          key={child.key}
                          type="button"
                          onClick={() => setActive(child.key)}
                          className={cn(
                            'mb-1 flex w-full items-center rounded-md px-2 py-1.5 text-sm transition-colors',
                            active === child.key
                              ? 'bg-primary/10 font-medium text-primary'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          {child.icon}
                          {child.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <button
                key={nav.key}
                type="button"
                onClick={() => setActive(nav.key)}
                className={cn(
                  'mb-1 flex w-full items-center rounded-md px-2 py-1.5 text-sm transition-colors',
                  active === nav.key
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {nav.icon}
                {nav.label}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex flex-wrap gap-2">
            {leaves.map((leaf) => (
              <button
                key={leaf.key}
                type="button"
                onClick={() => setActive(leaf.key)}
                className={cn(
                  'flex items-center rounded-md border px-3 py-1.5 text-sm transition-colors',
                  active === leaf.key
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {leaf.icon}
                {leaf.label}
              </button>
            ))}
          </div>
          <Active />
        </div>
      </div>
    </div>
  );
}
