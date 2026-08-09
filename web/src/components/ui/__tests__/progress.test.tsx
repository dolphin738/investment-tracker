/**
 * components/ui/progress.tsx — 原生 div 实现的 Progress（阶段 A · Q-8 甲）
 *
 * 背景：@radix-ui/react-progress 未安装（本批不装，避免 pnpm 重排 node_modules），
 * 工程师用原生 div + Tailwind 实现，API 与 shadcn 官方兼容。
 * 本套件锁定其对外契约，确保后续替换为 radix 版本时行为不漂移。
 *
 * 验证点：
 * 1. 无障碍语义：role="progressbar" + aria-valuemin/valuemax/valuenow
 * 2. 填充宽度与 value 一致（translateX(-(100-percent)%)）
 * 3. 边界：0 / 100 / null（不确定态）/ 越界钳制 / 自定义 max / 非法 max 不产生 NaN
 * 4. className / indicatorClassName / ref / 透传属性
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Progress } from '@/components/ui/progress';

/** 取进度条内部的填充条（indicator）元素 */
function getIndicator(): HTMLElement {
  const bar = screen.getByRole('progressbar');
  const indicator = bar.firstElementChild;
  if (!(indicator instanceof HTMLElement)) {
    throw new Error('Progress 缺少 indicator 子元素');
  }
  return indicator;
}

describe('Progress — 无障碍语义', () => {
  afterEach(cleanup);

  it('渲染 role="progressbar" 且 aria-valuemin/max/now 正确', () => {
    render(<Progress value={42} />);
    const bar = screen.getByRole('progressbar');

    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
  });

  it('自定义 max 时 aria-valuemax 同步', () => {
    render(<Progress value={7} max={10} />);
    const bar = screen.getByRole('progressbar');

    expect(bar.getAttribute('aria-valuemax')).toBe('10');
    expect(bar.getAttribute('aria-valuenow')).toBe('7');
  });

  it('value=null 为不确定态：不输出 aria-valuenow', () => {
    render(<Progress value={null} />);
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(
      false,
    );
  });

  it('未传 value 时同样视为不确定态', () => {
    render(<Progress />);
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(
      false,
    );
  });

  it('透传 aria-label（持仓页占比列依赖此项）', () => {
    render(<Progress value={30} aria-label="占比 30.00%" />);
    expect(screen.getByLabelText('占比 30.00%')).toBeDefined();
  });
});

describe('Progress — 填充宽度与 value 一致', () => {
  afterEach(cleanup);

  it.each([
    [0, 'translateX(-100%)'],
    [25, 'translateX(-75%)'],
    [50, 'translateX(-50%)'],
    [100, 'translateX(-0%)'],
  ])('value=%s → indicator transform %s', (value, expected) => {
    render(<Progress value={value as number} />);
    expect(getIndicator().style.transform).toBe(expected);
  });

  it('自定义 max：value=7 / max=10 → 70%', () => {
    render(<Progress value={7} max={10} />);
    expect(getIndicator().style.transform).toBe('translateX(-30%)');
  });

  it('不确定态渲染为空进度（0%）', () => {
    render(<Progress value={null} />);
    expect(getIndicator().style.transform).toBe('translateX(-100%)');
  });
});

describe('Progress — 越界与非法输入钳制', () => {
  afterEach(cleanup);

  it('value 超过 max 钳制为 max（不溢出）', () => {
    render(<Progress value={150} />);
    expect(getIndicator().style.transform).toBe('translateX(-0%)');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '100',
    );
  });

  it('负数 value 钳制为 0', () => {
    render(<Progress value={-20} />);
    expect(getIndicator().style.transform).toBe('translateX(-100%)');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '0',
    );
  });

  it('NaN value 按 0 处理，不产生 NaN 宽度', () => {
    render(<Progress value={Number.NaN} />);
    expect(getIndicator().style.transform).toBe('translateX(-100%)');
    expect(getIndicator().style.transform).not.toContain('NaN');
  });

  it('max=0 回落到 100，不发生除零', () => {
    render(<Progress value={50} max={0} />);
    expect(getIndicator().style.transform).toBe('translateX(-50%)');
    expect(getIndicator().style.transform).not.toContain('NaN');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe(
      '100',
    );
  });

  it('负 max 回落到 100，不产生负宽度', () => {
    render(<Progress value={25} max={-5} />);
    expect(getIndicator().style.transform).toBe('translateX(-75%)');
  });
});

describe('Progress — 样式与 ref 契约（shadcn API 兼容）', () => {
  afterEach(cleanup);

  it('className 合并到根元素', () => {
    render(<Progress value={10} className="h-1.5 w-16" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('h-1.5');
    expect(bar.className).toContain('w-16');
    // 基础样式仍在
    expect(bar.className).toContain('rounded-full');
  });

  it('indicatorClassName 作用于填充条而非根元素', () => {
    render(<Progress value={10} indicatorClassName="bg-up" />);
    expect(getIndicator().className).toContain('bg-up');
    expect(screen.getByRole('progressbar').className).not.toContain('bg-up');
  });

  it('forwardRef 指向根 div', () => {
    const ref = createRef<HTMLDivElement>();
    render(<Progress value={10} ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current?.getAttribute('role')).toBe('progressbar');
  });
});
