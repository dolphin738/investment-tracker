/**
 * Index — 路由入口页
 *
 * 根据登录状态跳转：
 * - 已登录 → Dashboard
 * - 未登录 → Login
 */

import { router } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';

@Entry
@Component
struct Index {
  @State isChecking: boolean = true;

  aboutToAppear(): void {
    this.checkAuthAndRedirect();
  }

  private async checkAuthAndRedirect(): Promise<void> {
    // 短暂延迟，确保 AppStorage 已初始化
    await new Promise<void>((resolve: () => void) => {
      setTimeout(resolve, 100);
    });

    if (AuthStore.isAuthenticated()) {
      router.replaceUrl({ url: 'pages/Dashboard' });
    } else {
      router.replaceUrl({ url: 'pages/Login' });
    }
  }

  build(): void {
    Column() {
      LoadingProgress()
        .width(48)
        .height(48)
        .color('#3b82f6')

      Text('投资收益统计')
        .fontSize(18)
        .fontColor('#94a3b8')
        .margin({ top: 16 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor('#0f172a')
  }
}
