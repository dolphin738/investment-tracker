/**
 * LoadingIndicator — 加载指示器
 *
 * 全屏或局部加载状态展示。
 */

@Component
export struct LoadingIndicator {
  /** 提示文案 */
  @Prop message: string = '加载中...';
  /** 是否全屏覆盖 */
  @Prop fullscreen: boolean = false;

  build(): void {
    Column() {
      LoadingProgress()
        .width(40)
        .height(40)
        .color('#3b82f6')

      Text(this.message)
        .fontSize(14)
        .fontColor('#94a3b8')
        .margin({ top: 12 })
    }
    .width('100%')
    .height(this.fullscreen ? '100%' : 'auto')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor(this.fullscreen ? '#0f172aCC' : 'transparent')
  }
}
