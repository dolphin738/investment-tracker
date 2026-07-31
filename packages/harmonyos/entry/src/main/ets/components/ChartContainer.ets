/**
 * ChartContainer — 图表容器
 *
 * 统一处理图表的加载态、空数据态和正常展示态。
 * 子内容通过 slot 方式注入（使用 @BuilderParam）。
 */

@Component
export struct ChartContainer {
  /** 是否加载中 */
  @Prop isLoading: boolean = false;
  /** 数据是否为空 */
  @Prop isEmpty: boolean = false;
  /** 空数据提示文案 */
  @Prop emptyText: string = '暂无数据';
  /** 图表标题 */
  @Prop title: string = '';
  /** 图表内容构建器 */
  @BuilderParam content: () => void;

  build(): void {
    Column() {
      if (this.title.length > 0) {
        Text(this.title)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#e2e8f0')
          .margin({ bottom: 8 })
      }

      if (this.isLoading) {
        Column() {
          LoadingProgress()
            .width(36)
            .height(36)
            .color('#3b82f6')
          Text('加载中...')
            .fontSize(13)
            .fontColor('#94a3b8')
            .margin({ top: 8 })
        }
        .width('100%')
        .height(220)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      } else if (this.isEmpty) {
        Column() {
          Text('📊')
            .fontSize(40)
            .margin({ bottom: 8 })
          Text(this.emptyText)
            .fontSize(13)
            .fontColor('#64748b')
        }
        .width('100%')
        .height(220)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      } else {
        this.content()
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor('#1e293b')
    .borderRadius(12)
  }
}
