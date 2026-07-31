/**
 * LineChart — 折线图组件（Canvas 自绘）
 *
 * 使用 ArkUI Canvas API 手动绘制折线图：
 * - 坐标系（Y 轴网格线 + 标签）
 * - 折线连线 + 数据点圆点
 * - X 轴标签（稀疏显示，避免重叠）
 * - 支持双线对比（如累计净值 vs 当年净值）
 * - 自动处理 null 值（跳过断点）
 *
 * HarmonyOS 无 Recharts/ECharts，使用 Canvas 自绘确保功能完整。
 */

@Component
export struct LineChart {
  /** 主数据线 Y 值数组（可含 null） */
  @Prop values: Array<number | null> = [];
  /** 主数据线 X 轴标签 */
  @Prop labels: string[] = [];
  /** 主数据线颜色 */
  @Prop lineColor: string = '#3b82f6';
  /** 副数据线 Y 值数组（可选，用于双线对比） */
  @Prop secondaryValues: Array<number | null> = [];
  /** 副数据线颜色 */
  @Prop secondaryColor: string = '#f59e0b';
  /** 图表高度（vp） */
  @Prop chartHeight: number = 220;
  /** Y 轴标签后缀（如 "%" 或 ""） */
  @Prop ySuffix: string = '';
  /** 副线图例名称 */
  @Prop secondaryLegend: string = '';
  /** 主线图例名称 */
  @Prop primaryLegend: string = '';

  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private context: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);
  private isCanvasReady: boolean = false;

  aboutToAppear(): void {
    // 组件创建时无需操作，等待 Canvas onReady
  }

  build(): void {
    Column() {
      Canvas(this.context)
        .width('100%')
        .height(this.chartHeight)
        .onReady(() => {
          this.isCanvasReady = true;
          this.drawChart();
        })
    }
    .width('100%')
  }

  /**
   * 绘制折线图
   */
  private drawChart(): void {
    const ctx = this.context;
    const width: number = ctx.width;
    const height: number = ctx.height;

    // 清空画布
    ctx.clearRect(0, 0, width, height);

    // 边距：左 50（Y 轴标签）、右 16、上 16、下 30（X 轴标签）
    const padLeft: number = 50;
    const padRight: number = 16;
    const padTop: number = 16;
    const padBottom: number = 30;
    const chartW: number = width - padLeft - padRight;
    const chartH: number = height - padTop - padBottom;

    // 合并主副数据线计算 Y 轴范围
    const allValues: number[] = [];
    this.collectValidValues(this.values, allValues);
    this.collectValidValues(this.secondaryValues, allValues);

    if (allValues.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.fillText('暂无数据', width / 2 - 28, height / 2);
      return;
    }

    let minVal: number = allValues[0];
    let maxVal: number = allValues[0];
    for (let i = 1; i < allValues.length; i++) {
      if (allValues[i] < minVal) minVal = allValues[i];
      if (allValues[i] > maxVal) maxVal = allValues[i];
    }

    // 范围留 10% 余量
    const range: number = maxVal - minVal;
    if (range === 0) {
      minVal = minVal - 1;
      maxVal = maxVal + 1;
    } else {
      minVal = minVal - range * 0.1;
      maxVal = maxVal + range * 0.1;
    }

    // 绘制 Y 轴网格线 + 标签（5 条）
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    const gridCount: number = 5;
    for (let i = 0; i <= gridCount; i++) {
      const y: number = padTop + (chartH / gridCount) * i;
      const val: number = maxVal - ((maxVal - minVal) / gridCount) * i;

      // 网格线
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      // Y 轴标签
      const label: string = val.toFixed(2) + this.ySuffix;
      ctx.fillText(label, 2, y + 4);
    }

    // 绘制 X 轴标签（稀疏显示，最多 6 个）
    const labelCount: number = this.labels.length;
    if (labelCount > 0) {
      const maxLabels: number = Math.min(6, labelCount);
      const step: number = Math.ceil(labelCount / maxLabels);
      ctx.fillStyle = '#64748b';
      ctx.font = '10px sans-serif';

      for (let i = 0; i < labelCount; i += step) {
        const x: number = padLeft + (chartW / Math.max(1, labelCount - 1)) * i;
        const label: string = this.labels[i];
        // 截断过长标签
        const displayLabel: string = label.length > 8 ? label.substring(0, 8) : label;
        ctx.fillText(displayLabel, x - displayLabel.length * 3, height - 8);
      }
    }

    // 绘制副数据线（先画，在主线下方）
    if (this.secondaryValues.length > 0) {
      this.drawLine(ctx, this.secondaryValues, this.secondaryColor, padLeft, padTop, chartW, chartH, minVal, maxVal, labelCount);
    }

    // 绘制主数据线
    if (this.values.length > 0) {
      this.drawLine(ctx, this.values, this.lineColor, padLeft, padTop, chartW, chartH, minVal, maxVal, labelCount);
    }

    // 绘制图例
    if (this.primaryLegend.length > 0 || this.secondaryLegend.length > 0) {
      let legendX: number = padLeft + 4;
      const legendY: number = padTop + 4;

      if (this.primaryLegend.length > 0) {
        ctx.fillStyle = this.lineColor;
        ctx.fillRect(legendX, legendY, 12, 3);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px sans-serif';
        ctx.fillText(this.primaryLegend, legendX + 16, legendY + 4);
        legendX += 16 + this.primaryLegend.length * 6 + 8;
      }

      if (this.secondaryLegend.length > 0) {
        ctx.fillStyle = this.secondaryColor;
        ctx.fillRect(legendX, legendY, 12, 3);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px sans-serif';
        ctx.fillText(this.secondaryLegend, legendX + 16, legendY + 4);
      }
    }
  }

  /**
   * 绘制单条折线
   */
  private drawLine(
    ctx: CanvasRenderingContext2D,
    values: Array<number | null>,
    color: string,
    padLeft: number, padTop: number,
    chartW: number, chartH: number,
    minVal: number, maxVal: number,
    labelCount: number,
  ): void {
    const count: number = values.length;
    if (count === 0) return;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    let hasMoved: boolean = false;
    const pointPositions: number[] = [];

    for (let i = 0; i < count; i++) {
      const val = values[i];
      if (val === null || val === undefined || isNaN(val)) {
        pointPositions.push(-1);
        hasMoved = false;
        continue;
      }

      const x: number = padLeft + (chartW / Math.max(1, count - 1)) * i;
      const y: number = padTop + chartH - ((val - minVal) / (maxVal - minVal)) * chartH;

      pointPositions.push(y);

      if (!hasMoved) {
        ctx.moveTo(x, y);
        hasMoved = true;
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();

    // 绘制数据点（稀疏，避免过多圆点影响性能）
    const maxDots: number = 30;
    const dotStep: number = Math.max(1, Math.ceil(count / maxDots));
    for (let i = 0; i < count; i += dotStep) {
      if (pointPositions[i] < 0) continue;
      const x: number = padLeft + (chartW / Math.max(1, count - 1)) * i;
      const y: number = pointPositions[i];
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * 收集有效数值（非 null、非 NaN）
   */
  private collectValidValues(values: Array<number | null>, result: number[]): void {
    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      if (val !== null && val !== undefined && !isNaN(val)) {
        result.push(val);
      }
    }
  }
}
