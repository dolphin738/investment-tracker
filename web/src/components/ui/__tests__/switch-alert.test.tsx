/**
 * components/ui/switch.tsx + alert.tsx — 冒烟契约测试（阶段 A · Q-8 甲）
 *
 * 这两个组件本批**未被任何页面引用**（供后续阶段使用），tsc 只做静态检查，
 * 运行期行为无人覆盖。补一层冒烟测试，确保：
 * - Switch 依赖的 @radix-ui/react-switch@1.3.7 在 jsdom 下真能挂载与切换
 *   （避免「装了但跑不起来」到下个阶段才暴露）
 * - Alert 的 cva variants 输出正确、三段式组合可用
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

describe('Switch — Radix 依赖可用性冒烟', () => {
  afterEach(cleanup);

  it('渲染 role="switch" 且默认未选中', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');

    expect(sw).toBeDefined();
    expect(sw.getAttribute('data-state')).toBe('unchecked');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('非受控 defaultChecked 生效', () => {
    render(<Switch defaultChecked />);
    expect(screen.getByRole('switch').getAttribute('data-state')).toBe(
      'checked',
    );
  });

  it('点击触发 onCheckedChange 并切换状态（非受控）', () => {
    const onCheckedChange = vi.fn();
    render(<Switch onCheckedChange={onCheckedChange} />);

    const sw = screen.getByRole('switch');
    fireEvent.click(sw);

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('data-state')).toBe('checked');
  });

  it('受控模式下不自行改状态，由外部 checked 决定', () => {
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <Switch checked={false} onCheckedChange={onCheckedChange} />,
    );

    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    // 外部未更新 checked → 仍保持 unchecked
    expect(screen.getByRole('switch').getAttribute('data-state')).toBe(
      'unchecked',
    );

    rerender(<Switch checked onCheckedChange={onCheckedChange} />);
    expect(screen.getByRole('switch').getAttribute('data-state')).toBe(
      'checked',
    );
  });

  it('disabled 时点击不回调', () => {
    const onCheckedChange = vi.fn();
    render(<Switch disabled onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('渲染 Thumb 子元素并合并自定义 className', () => {
    render(<Switch className="ml-2" />);
    const sw = screen.getByRole('switch');

    expect(sw.className).toContain('ml-2');
    expect(sw.firstElementChild).not.toBeNull();
  });
});

describe('Alert — 三段式组合与 variants', () => {
  afterEach(cleanup);

  it('默认 variant 渲染 role="alert" 与标题/描述', () => {
    render(
      <Alert>
        <AlertTitle>数据陈旧</AlertTitle>
        <AlertDescription>最新净值日期距今已超过 3 天。</AlertDescription>
      </Alert>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toBeDefined();
    expect(alert.className).toContain('bg-background');
    expect(screen.getByText('数据陈旧')).toBeDefined();
    expect(screen.getByText('最新净值日期距今已超过 3 天。')).toBeDefined();
  });

  it('variant="destructive" 输出 destructive 类', () => {
    render(<Alert variant="destructive">出错了</Alert>);
    expect(screen.getByRole('alert').className).toContain(
      'border-destructive/50',
    );
  });

  it('variant="warning" 输出 amber 类（本仓库扩展项）', () => {
    render(<Alert variant="warning">注意</Alert>);
    expect(screen.getByRole('alert').className).toContain('border-amber-500/50');
  });

  it('AlertTitle 渲染为 h5，AlertDescription 渲染为 div', () => {
    render(
      <Alert>
        <AlertTitle>标题</AlertTitle>
        <AlertDescription>描述</AlertDescription>
      </Alert>,
    );

    expect(screen.getByText('标题').tagName).toBe('H5');
    expect(screen.getByText('描述').tagName).toBe('DIV');
  });

  it('className 可覆盖合并', () => {
    render(<Alert className="mt-4">x</Alert>);
    expect(screen.getByRole('alert').className).toContain('mt-4');
  });
});
