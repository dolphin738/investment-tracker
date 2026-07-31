/**
 * EmptyState — 空数据占位组件
 *
 * 用于列表页、分析页等无数据时的占位提示。
 */

@Component
export struct EmptyState {
  /** 提示文案 */
  @Prop message: string = '暂无数据';
  /** 图标符号 */
  @Prop icon: string = '📭';
  /** 副标题（可选） */
  @Prop subtitle: string = '';

  build(): void {
    Column() {
      Text(this.icon)
        .fontSize(48)
        .margin({ bottom: 12 })

      Text(this.message)
        .fontSize(15)
        .fontColor('#94a3b8')
        .textAlign(TextAlign.Center)

      if (this.subtitle.length > 0) {
        Text(this.subtitle)
          .fontSize(13)
          .fontColor('#64748b')
          .margin({ top: 4 })
          .textAlign(TextAlign.Center)
      }
    }
    .width('100%')
    .padding({ top: 48, bottom: 48 })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }
}
