/**
 * StatCard — 指标卡片组件
 *
 * 展示单个关键指标：标题 + 数值 + 变化趋势（可选）
 * 用于 Dashboard 页面的指标卡片组（累计 XIRR / 总收益率 / 当年收益率）。
 *
 * 暗色主题，与 Web 端对齐。
 */

@Component
export struct StatCard {
  /** 卡片标题（如 "累计XIRR"） */
  @Prop title: string = '';
  /** 主数值（已格式化的字符串，如 "12.34%"） */
  @Prop value: string = '--';
  /** 副标题/趋势（如 "+2.1pp" 或 "较年初"） */
  @Prop subtitle: string = '';
  /** 副标题颜色：正值绿色、负值红色、默认灰色 */
  @Prop subtitleColor: string = '#94a3b8';
  /** 数值颜色（默认主文本色） */
  @Prop valueColor: string = '#e2e8f0';

  build(): void {
    Column() {
      Text(this.title)
        .fontSize(13)
        .fontColor('#94a3b8')
        .margin({ bottom: 6 })

      Text(this.value)
        .fontSize(26)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.valueColor)

      if (this.subtitle.length > 0) {
        Text(this.subtitle)
          .fontSize(12)
          .fontColor(this.subtitleColor)
          .margin({ top: 4 })
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor('#1e293b')
    .borderRadius(12)
    .alignItems(HorizontalAlign.Start)
  }
}
