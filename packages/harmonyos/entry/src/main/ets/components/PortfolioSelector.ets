/**
 * PortfolioSelector — 组合选择器
 *
 * 展示当前选中的组合名称，点击弹出组合列表供切换。
 * 支持快速创建新组合。
 *
 * 使用 AppStorage 同步当前组合 ID（@StorageLink）。
 */

import { router } from '@kit.ArkUI';
import { ApiConfig } from '../common/net/api-config';
import { PortfolioStore } from '../common/store/portfolio-store';
import type { Portfolio } from '../common/net/api-types';

@Component
export struct PortfolioSelector {
  /** 组合列表（由父页面传入） */
  @Prop portfolios: Portfolio[] = [];
  /** 当前选中的组合 ID（与 AppStorage 双向绑定） */
  @StorageLink(ApiConfig.PORTFOLIO_KEY) currentPortfolioId: string = '';
  /** 是否显示组合列表弹层 */
  @State showList: boolean = false;
  /** 新建组合名称输入 */
  @State newPortfolioName: string = '';
  /** 是否显示新建输入框 */
  @State showCreateInput: boolean = false;

  /**
   * 获取当前选中组合的名称
   */
  private getCurrentName(): string {
    for (let i = 0; i < this.portfolios.length; i++) {
      if (this.portfolios[i].id === this.currentPortfolioId) {
        return this.portfolios[i].name;
      }
    }
    return '选择组合';
  }

  /**
   * 选择组合
   */
  private selectPortfolio(id: string): void {
    this.currentPortfolioId = id;
    this.showList = false;
  }

  /**
   * 创建新组合
   */
  private async createPortfolio(): Promise<void> {
    if (this.newPortfolioName.trim().length === 0) {
      return;
    }
    try {
      const portfolio = await PortfolioStore.createPortfolio(this.newPortfolioName.trim());
      this.newPortfolioName = '';
      this.showCreateInput = false;
      this.currentPortfolioId = portfolio.id;
      this.showList = false;
    } catch (error) {
      // 创建失败，保持弹层打开
    }
  }

  build(): void {
    Column() {
      // 当前组合名称 + 下拉箭头
      Row() {
        Text(this.getCurrentName())
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor('#e2e8f0')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)

        Text('▼')
          .fontSize(10)
          .fontColor('#94a3b8')
          .margin({ left: 4 })
      }
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .backgroundColor('#334155')
      .borderRadius(8)
      .onClick(() => {
        this.showList = !this.showList;
      })

      // 组合列表弹层
      if (this.showList) {
        Column() {
          ForEach(this.portfolios, (portfolio: Portfolio) => {
            Row() {
              Text(portfolio.name)
                .fontSize(15)
                .fontColor(portfolio.id === this.currentPortfolioId ? '#3b82f6' : '#e2e8f0')
                .layoutWeight(1)

              if (portfolio.id === this.currentPortfolioId) {
                Text('✓')
                  .fontSize(14)
                  .fontColor('#3b82f6')
              }
            }
            .width('100%')
            .padding({ left: 12, right: 12, top: 12, bottom: 12 })
            .onClick(() => {
              this.selectPortfolio(portfolio.id);
            })
          })

          // 新建组合区域
          if (this.showCreateInput) {
            Row() {
              TextInput({ text: this.newPortfolioName, placeholder: '输入组合名称' })
                .layoutWeight(1)
                .fontSize(15)
                .backgroundColor('#0f172a')
                .fontColor('#e2e8f0')
                .borderRadius(6)
                .onChange((value: string) => {
                  this.newPortfolioName = value;
                })

              Button('创建')
                .fontSize(14)
                .fontColor('#ffffff')
                .backgroundColor('#3b82f6')
                .borderRadius(6)
                .margin({ left: 8 })
                .onClick(() => {
                  this.createPortfolio();
                })
            }
            .width('100%')
            .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          } else {
            Row() {
              Text('+ 新建组合')
                .fontSize(15)
                .fontColor('#3b82f6')
            }
            .width('100%')
            .padding({ left: 12, right: 12, top: 12, bottom: 12 })
            .onClick(() => {
              this.showCreateInput = true;
            })
          }
        }
        .width('100%')
        .margin({ top: 4 })
        .backgroundColor('#1e293b')
        .borderRadius(8)
        .border({ width: 1, color: '#334155' })
      }
    }
    .width('100%')
  }
}
