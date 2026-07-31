/**
 * Settings — 设置页
 *
 * 包含：账户信息、组合管理、净值分析入口、退出登录、关于。
 */

import { router, promptAction } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';
import { PortfolioStore } from '../common/store/portfolio-store';
import { ApiConfig } from '../common/net/api-config';
import type { Portfolio, UserInfo } from '../common/net/api-types';
import { BottomNav } from '../components/BottomNav';

@Entry
@Component
struct Settings {
  @StorageLink(ApiConfig.USER_KEY) user: UserInfo | null = null;
  @StorageLink(ApiConfig.TOKEN_KEY) token: string = '';
  @StorageLink(ApiConfig.PORTFOLIO_KEY) currentPortfolioId: string = '';
  @State portfolios: Portfolio[] = [];
  @State isLoading: boolean = false;

  aboutToAppear(): void {
    this.loadPortfolios();
  }

  private async loadPortfolios(): Promise<void> {
    if (!AuthStore.isAuthenticated()) {
      router.replaceUrl({ url: 'pages/Login' });
      return;
    }
    this.isLoading = true;
    try {
      this.portfolios = await PortfolioStore.listPortfolios();
      // 确保有选中的组合
      if (this.currentPortfolioId.length === 0 && this.portfolios.length > 0) {
        this.currentPortfolioId = this.portfolios[0].id;
      }
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '加载失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 退出登录
   */
  private async handleLogout(): Promise<void> {
    try {
      await AuthStore.logout();
      promptAction.showToast({ message: '已退出登录', duration: 1500 });
      router.replaceUrl({ url: 'pages/Login' });
    } catch (error) {
      promptAction.showToast({ message: '退出失败', duration: 2000 });
    }
  }

  /**
   * 删除组合
   */
  private async handleDeletePortfolio(portfolio: Portfolio): Promise<void> {
    try {
      await PortfolioStore.deletePortfolio(portfolio.id);
      promptAction.showToast({ message: '组合已删除', duration: 1500 });
      await this.loadPortfolios();
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '删除失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    }
  }

  /**
   * 选择组合
   */
  private selectPortfolio(id: string): void {
    this.currentPortfolioId = id;
    promptAction.showToast({ message: '已切换组合', duration: 1000 });
  }

  build(): void {
    Column() {
      // 顶部标题栏
      Row() {
        Text('设置')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor('#e2e8f0')
      }
      .width('100%')
      .height(56)
      .padding({ left: 16, right: 16 })
      .backgroundColor('#1e293b')
      .alignItems(VerticalAlign.Center)

      // 内容区域（可滚动）
      Scroll() {
        Column() {
          // ===== 账户信息 =====
          Text('账户')
            .fontSize(14)
            .fontColor('#94a3b8')
            .margin({ top: 16, bottom: 8, left: 4 })

          Column() {
            Row() {
              Text('邮箱')
                .fontSize(15)
                .fontColor('#94a3b8')
              Text(this.user ? this.user.email : '--')
                .fontSize(15)
                .fontColor('#e2e8f0')
            }
            .width('100%')
            .padding({ top: 14, bottom: 14, left: 16, right: 16 })
            .justifyContent(FlexAlign.SpaceBetween)

            Divider().color('#334155').strokeWidth(1)

            Row() {
              Text('昵称')
                .fontSize(15)
                .fontColor('#94a3b8')
              Text(this.user && this.user.name ? this.user.name : '未设置')
                .fontSize(15)
                .fontColor('#e2e8f0')
            }
            .width('100%')
            .padding({ top: 14, bottom: 14, left: 16, right: 16 })
            .justifyContent(FlexAlign.SpaceBetween)
          }
          .width('100%')
          .backgroundColor('#1e293b')
          .borderRadius(12)

          // ===== 组合管理 =====
          Text('组合管理')
            .fontSize(14)
            .fontColor('#94a3b8')
            .margin({ top: 24, bottom: 8, left: 4 })

          Column() {
            ForEach(this.portfolios, (portfolio: Portfolio) => {
              Row() {
                Column() {
                  Text(portfolio.name)
                    .fontSize(15)
                    .fontColor(portfolio.id === this.currentPortfolioId ? '#3b82f6' : '#e2e8f0')
                    .fontWeight(portfolio.id === this.currentPortfolioId ? FontWeight.Medium : FontWeight.Normal)
                  if (portfolio.description && portfolio.description.length > 0) {
                    Text(portfolio.description)
                      .fontSize(12)
                      .fontColor('#64748b')
                      .margin({ top: 2 })
                  }
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)

                if (portfolio.id === this.currentPortfolioId) {
                  Text('当前')
                    .fontSize(11)
                    .fontColor('#3b82f6')
                    .padding({ left: 8, right: 8, top: 2, bottom: 2 })
                    .backgroundColor('#3b82f620')
                    .borderRadius(4)
                    .margin({ right: 8 })
                }

                Text('删除')
                  .fontSize(13)
                  .fontColor('#ef4444')
                  .onClick(() => {
                    this.handleDeletePortfolio(portfolio);
                  })
              }
              .width('100%')
              .padding({ top: 14, bottom: 14, left: 16, right: 16 })
              .onClick(() => {
                this.selectPortfolio(portfolio.id);
              })

              if (this.portfolios.indexOf(portfolio) < this.portfolios.length - 1) {
                Divider().color('#334155').strokeWidth(1)
              }
            })
          }
          .width('100%')
          .backgroundColor('#1e293b')
          .borderRadius(12)

          // ===== 净值分析入口 =====
          Text('分析')
            .fontSize(14)
            .fontColor('#94a3b8')
            .margin({ top: 24, bottom: 8, left: 4 })

          Column() {
            Row() {
              Text('净值分析')
                .fontSize(15)
                .fontColor('#e2e8f0')
                .layoutWeight(1)
              Text('›')
                .fontSize(18)
                .fontColor('#64748b')
            }
            .width('100%')
            .padding({ top: 14, bottom: 14, left: 16, right: 16 })
            .onClick(() => {
              router.pushUrl({ url: 'pages/NavAnalysis' });
            })
          }
          .width('100%')
          .backgroundColor('#1e293b')
          .borderRadius(12)

          // ===== 退出登录 =====
          Button('退出登录')
            .width('100%')
            .height(48)
            .fontSize(16)
            .fontColor('#ef4444')
            .backgroundColor('#1e293b')
            .borderRadius(12)
            .margin({ top: 32 })
            .onClick(() => {
              this.handleLogout();
            })

          // ===== 关于 =====
          Text('关于')
            .fontSize(14)
            .fontColor('#94a3b8')
            .margin({ top: 24, bottom: 8, left: 4 })

          Column() {
            Row() {
              Text('版本')
                .fontSize(15)
                .fontColor('#94a3b8')
              Text('v1.0.0')
                .fontSize(15)
                .fontColor('#e2e8f0')
            }
            .width('100%')
            .padding({ top: 14, bottom: 14, left: 16, right: 16 })
            .justifyContent(FlexAlign.SpaceBetween)
          }
          .width('100%')
          .backgroundColor('#1e293b')
          .borderRadius(12)

          Text('XIRR 计算说明：基于 Newton-Raphson 迭代法求解年化收益率')
            .fontSize(12)
            .fontColor('#64748b')
            .margin({ top: 16, bottom: 16 })
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding({ left: 16, right: 16 })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)

      // 底部导航栏
      BottomNav({ currentPage: 'Settings' })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0f172a')
  }
}
