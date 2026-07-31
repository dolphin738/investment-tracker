/**
 * BottomNav — 底部导航栏
 *
 * 5 个 Tab：首页 / 交易 / 快照 / 分析 / 设置
 * 使用 router.replaceUrl 切换页面（单栈模式，避免页面堆叠）。
 *
 * 在各主页面中引入此组件，传入 currentPage 标识当前所在页面。
 */

import { router } from '@kit.ArkUI';

@Component
export struct BottomNav {
  /** 当前页面名称（用于高亮当前 Tab） */
  @Prop currentPage: string = '';

  /** Tab 配置 */
  private readonly tabs: Array<{ key: string; label: string; icon: string; page: string }> = [
    { key: 'Dashboard', label: '首页', icon: '📊', page: 'pages/Dashboard' },
    { key: 'Transactions', label: '交易', icon: '💰', page: 'pages/Transactions' },
    { key: 'Snapshots', label: '快照', icon: '📷', page: 'pages/Snapshots' },
    { key: 'XirrAnalysis', label: '分析', icon: '📈', page: 'pages/XirrAnalysis' },
    { key: 'Settings', label: '设置', icon: '⚙', page: 'pages/Settings' },
  ];

  /**
   * 切换页面
   */
  private switchTo(page: string, key: string): void {
    if (key === this.currentPage) {
      return; // 已在当前页面，不跳转
    }
    router.replaceUrl({ url: page });
  }

  build(): void {
    Row() {
      ForEach(this.tabs, (tab: { key: string; label: string; icon: string; page: string }) => {
        Column() {
          Text(tab.icon)
            .fontSize(20)
            .margin({ bottom: 2 })

          Text(tab.label)
            .fontSize(11)
            .fontColor(tab.key === this.currentPage ? '#3b82f6' : '#64748b')
            .fontWeight(tab.key === this.currentPage ? FontWeight.Medium : FontWeight.Normal)
        }
        .layoutWeight(1)
        .padding({ top: 8, bottom: 8 })
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .onClick(() => {
          this.switchTo(tab.page, tab.key);
        })
      })
    }
    .width('100%')
    .height(56)
    .backgroundColor('#1e293b')
    .border({ width: { top: 1 }, color: { top: '#334155' } })
  }
}
