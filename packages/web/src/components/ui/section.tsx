/**
 * components/ui/section.tsx — 页面纵向分区骨架（纯展示，无状态）
 *
 * 【为什么需要】概览页原先是一串平铺的 div（8 卡 → 筛选栏 → 走势图 → 四宫格），
 * 缺少「区」的概念，扫读时所有内容权重相同。本组件提供统一的轻量分区外壳：
 * 小标题 + 可选描述 + 可选右上角操作位，区内元素默认 `space-y-4`。
 *
 * 【克制原则】只用留白与字号建立层次，**不画分隔线、不加背景块** ——
 * 页面内容本身已是卡片（有边框有底色），再套一层容器会变成「框中框」。
 *
 * 【主题】仅使用语义色（`text-muted-foreground` 等），深浅色主题自动适配，
 * 不写死任何 hex。
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SectionProps {
  /** 区块标题（如「关键指标」「趋势分析」） */
  title: string;
  /** 区块描述，缺省不渲染 */
  description?: string;
  /** 右上角操作位（如筛选器、跳转链接），缺省不渲染 */
  action?: ReactNode;
  /** 区块内容；多个直接子节点之间由 `space-y-4` 拉开 */
  children: ReactNode;
  /** 追加类名（用于覆盖默认间距等） */
  className?: string;
}

/**
 * 页面区块容器。
 *
 * @param props 见 {@link SectionProps}
 * @returns 带标题的 `<section>`，内容区默认纵向间距 `space-y-4`
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
}: SectionProps): JSX.Element {
  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export interface SectionTitleProps {
  /** 分组标题文案 */
  children: ReactNode;
  /** 追加类名 */
  className?: string;
}

/**
 * 区块内的二级分组标题（比 {@link Section} 的 h2 更轻）。
 *
 * 用于在一个区块里再分组，例如「关键指标」区内的「资产构成 / 收益表现」。
 * 刻意做成弱化的灰色小字：它是扫读锚点，不该跟卡片标题抢视觉权重。
 *
 * @param props 见 {@link SectionTitleProps}
 * @returns 轻量 `<h3>` 标题
 */
export function SectionTitle({
  children,
  className,
}: SectionTitleProps): JSX.Element {
  return (
    <h3
      className={cn(
        'text-sm font-medium tracking-wide text-muted-foreground',
        className,
      )}
    >
      {children}
    </h3>
  );
}
