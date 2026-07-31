/**
 * BarChart — 柱状图组件（ArkUI 原生布局）
 *
 * 使用 Column + Row 布局 + 高度比例计算绘制柱状图。
 * 支持正负值（正向绿色、负向红色），适用于年度收益对比。
 */

@Component
export struct BarChart {
  /** 柱状图数值数组 */
  @Prop values: number[] = [];
  /** X 轴标签数组 */
  @Prop labels: string[] = [];
  /** 正值颜色 */
  @Prop positiveColor: string = '#22c55e';
  /** 负值颜色 */
  @Prop negativeColor: string = '#ef4444';
  /** 图表高度 */
  @Prop chartHeight: number = 200;
  /** 数值后缀（如 "%"） */
  @Prop valueSuffix: string = '%';

  build(): void {
    Column() {
      if (this.values.length === 0) {
        Column() {
          Text('📊')
            .fontSize(36)
            .margin({ bottom: 8 })
          Text('暂无数据')
            .fontSize(13)
            .fontColor('#64748b')
        }
        .width('100%')
        .height(this.chartHeight)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      } else {
        this.buildBars()
      }
    }
    .width('100%')
  }

  /**
   * 构建柱状图主体
   */
  @Builder
  buildBars(): void {
    // 计算最大绝对值用于高度比例
    let maxAbs: number = 0;
    for (let i = 0; i < this.values.length; i++) {
      const abs: number = Math.abs(this.values[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
    if (maxAbs === 0) maxAbs = 1;

    // 基准线位置（0 值所在的 Y 坐标比例）
    let minVal: number = 0;
    let maxVal: number = 0;
    for (let i = 0; i < this.values.length; i++) {
      if (this.values[i] < minVal) minVal = this.values[i];
      if (this.values[i] > maxVal) maxVal = this.values[i];
    }
    const totalRange: number = maxVal - minVal;
    const zeroRatio: number = totalRange === 0 ? 1 : maxVal / totalRange;
    const barAreaHeight: number = this.chartHeight - 40; // 留 40 给标签

    Row() {
      ForEach(this.values, (val: number, index: number) => {
        Column() {
          // 上半部分（正值区域）
          Column() {
            if (val >= 0) {
              Column()
                .width('80%')
                .height((Math.abs(val) / maxAbs) * barAreaHeight * zeroRatio)
                .backgroundColor(this.positiveColor)
                .borderRadius({ topLeft: 4, topRight: 4 })
            }
          }
          .width('100%')
          .height(barAreaHeight * zeroRatio)
          .justifyContent(FlexAlign.End)
          .alignItems(HorizontalAlign.Center)

          // 下半部分（负值区域）
          Column() {
            if (val < 0) {
              Column()
                .width('80%')
                .height((Math.abs(val) / maxAbs) * barAreaHeight * (1 - zeroRatio))
                .backgroundColor(this.negativeColor)
                .borderRadius({ bottomLeft: 4, bottomRight: 4 })
            }
          }
          .width('100%')
          .height(barAreaHeight * (1 - zeroRatio))
          .justifyContent(FlexAlign.Start)
          .alignItems(HorizontalAlign.Center)

          // X 轴标签
          Text(this.labels.length > index ? this.labels[index] : '')
            .fontSize(10)
            .fontColor('#94a3b8')
            .margin({ top: 4 })
            .maxLines(1)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Center)
        .padding({ left: 2, right: 2 })
      })
    }
    .width('100%')
    .height(this.chartHeight)
    .alignItems(VerticalAlign.Bottom)
  }
}
