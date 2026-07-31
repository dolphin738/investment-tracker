/**
 * NavAnalysis — 净值分析页
 *
 * 功能：
 * - 四维度切换（日/周/月/年）
 * - 累计净值 + 当年净值双线对比折线图（Canvas 自绘）
 * - 当前净值摘要（累计净值 / 当年净值 / 累计收益 / 当年收益）
 * - 每日净值明细列表（日期 / 累计净值 / 当年净值 / 份额）
 */

import { router, promptAction } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';
import { PortfolioStore } from '../common/store/portfolio-store';
import { QueryApi } from '../common/api/query-api';
import { ApiConfig } from '../common/net/api-config';
import { FormatUtil } from '../common/utils/format';
import { DateUtil } from '../common/utils/date';
import { LineChart } from '../components/LineChart';
import { EmptyState } from '../components/EmptyState';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { BottomNav } from '../components/BottomNav';
import type { Portfolio, NavSeriesPoint, LatestNav } from '../common/net/api-types';

@Entry
@Component
struct NavAnalysis {
  @StorageLink(ApiConfig.PORTFOLIO_KEY) @Watch('onPortfolioChange') currentPortfolioId: string = '';
  @State portfolios: Portfolio[] = [];
  @State currentGranularity: string = 'month';
  @State navSeries: NavSeriesPoint[] = [];
  @State latestNav: LatestNav | null = null;
  @State isLoading: boolean = false;

  aboutToAppear(): void {
    this.initPage();
  }

  private async initPage(): Promise<void> {
    if (!AuthStore.isAuthenticated()) {
      router.replaceUrl({ url: 'pages/Login' });
      return;
    }
    try {
      this.portfolios = await PortfolioStore.listPortfolios();
      const selectedId = await PortfolioStore.ensureSelected();
      if (selectedId.length > 0) {
        this.currentPortfolioId = selectedId;
        await this.loadAllData();
      }
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '加载失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    }
  }

  onPortfolioChange(): void {
    if (this.currentPortfolioId.length > 0) {
      this.loadAllData();
    }
  }

  private async loadAllData(): Promise<void> {
    this.loadNavSeries();
    this.loadLatestNav();
  }

  /**
   * 加载净值时间序列
   */
  private async loadNavSeries(): Promise<void> {
    this.isLoading = true;
    try {
      const range = DateUtil.getDefaultRange(this.currentGranularity);
      this.navSeries = await QueryApi.getNavSeries(
        this.currentPortfolioId,
        this.currentGranularity,
        range.startDate,
        range.endDate,
      );
    } catch (error) {
      this.navSeries = [];
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 加载最新净值
   */
  private async loadLatestNav(): Promise<void> {
    try {
      this.latestNav = await QueryApi.getLatestNav(this.currentPortfolioId);
    } catch (error) {
      this.latestNav = null;
    }
  }

  /**
   * 切换粒度
   */
  private switchGranularity(g: string): void {
    if (g === this.currentGranularity) return;
    this.currentGranularity = g;
    this.loadNavSeries();
  }

  /**
   * 获取累计净值 Y 值
   */
  private getCumulativeValues(): Array<number | null> {
    const result: Array<number | null> = [];
    for (let i = 0; i < this.navSeries.length; i++) {
      result.push(this.navSeries[i].cumulativeNav);
    }
    return result;
  }

  /**
   * 获取当年净值 Y 值
   */
  private getYearValues(): Array<number | null> {
    const result: Array<number | null> = [];
    for (let i = 0; i < this.navSeries.length; i++) {
      result.push(this.navSeries[i].yearNav);
    }
    return result;
  }

  /**
   * 获取 X 轴标签
   */
  private getChartLabels(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.navSeries.length; i++) {
      result.push(this.navSeries[i].label);
    }
    return result;
  }

  build(): void {
    Column() {
      // 顶部标题栏
      Row() {
        Text('净值分析')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor('#e2e8f0')
          .layoutWeight(1)
      }
      .width('100%')
      .height(56)
      .padding({ left: 16, right: 16 })
      .backgroundColor('#1e293b')
      .alignItems(VerticalAlign.Center)

      // 组合选择器
      Column() {
        PortfolioSelector({ portfolios: this.portfolios })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12 })

      if (this.currentPortfolioId.length === 0) {
        EmptyState({ message: '请先创建投资组合', icon: '💼' })
          .layoutWeight(1)
      } else {
        Scroll() {
          Column() {
            // 净值摘要卡片
            Row() {
              Column() {
                Text('累计净值')
                  .fontSize(12)
                  .fontColor('#94a3b8')
                Text(this.latestNav && this.latestNav.cumulativeNav !== null
                  ? FormatUtil.formatDecimal(this.latestNav.cumulativeNav, 4)
                  : '--')
                  .fontSize(22)
                  .fontWeight(FontWeight.Bold)
                  .fontColor('#3b82f6')
                  .margin({ top: 2 })
                Text(this.latestNav && this.latestNav.cumulativeNav !== null
                  ? FormatUtil.formatPercentSigned(this.latestNav.cumulativeNav - 1)
                  : '--')
                  .fontSize(12)
                  .fontColor(this.latestNav && this.latestNav.cumulativeNav !== null && this.latestNav.cumulativeNav >= 1 ? '#22c55e' : '#ef4444')
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              Column() {
                Text('当年净值')
                  .fontSize(12)
                  .fontColor('#94a3b8')
                Text(this.latestNav && this.latestNav.yearNav !== null
                  ? FormatUtil.formatDecimal(this.latestNav.yearNav, 4)
                  : '--')
                  .fontSize(22)
                  .fontWeight(FontWeight.Bold)
                  .fontColor('#f59e0b')
                  .margin({ top: 2 })
                Text(this.latestNav && this.latestNav.yearNav !== null
                  ? FormatUtil.formatPercentSigned(this.latestNav.yearNav - 1)
                  : '--')
                  .fontSize(12)
                  .fontColor(this.latestNav && this.latestNav.yearNav !== null && this.latestNav.yearNav >= 1 ? '#22c55e' : '#ef4444')
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
            }
            .width('100%')
            .padding(16)
            .backgroundColor('#1e293b')
            .borderRadius(12)
            .margin({ bottom: 12 })

            // 粒度切换 Tab
            Row() {
              ForEach(DateUtil.getAllGranularities(), (g: string) => {
                Text(DateUtil.getGranularityShortLabel(g))
                  .fontSize(14)
                  .fontColor(g === this.currentGranularity ? '#ffffff' : '#94a3b8')
                  .fontWeight(g === this.currentGranularity ? FontWeight.Medium : FontWeight.Normal)
                  .padding({ left: 16, right: 16, top: 8, bottom: 8 })
                  .backgroundColor(g === this.currentGranularity ? '#3b82f6' : 'transparent')
                  .borderRadius(8)
                  .onClick(() => {
                    this.switchGranularity(g);
                  })
                  .layoutWeight(1)
                  .textAlign(TextAlign.Center)
              })
            }
            .width('100%')
            .backgroundColor('#1e293b')
            .borderRadius(8)
            .padding(4)
            .margin({ bottom: 12 })

            // 净值双线对比图
            Column() {
              Text(`净值趋势（${DateUtil.getGranularityLabel(this.currentGranularity)}）`)
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .fontColor('#e2e8f0')
                .margin({ bottom: 8 })

              if (this.isLoading) {
                Column() {
                  LoadingProgress().width(36).height(36).color('#3b82f6')
                  Text('加载中...').fontSize(13).fontColor('#94a3b8').margin({ top: 8 })
                }
                .width('100%')
                .height(220)
                .justifyContent(FlexAlign.Center)
                .alignItems(HorizontalAlign.Center)
              } else if (this.navSeries.length === 0) {
                Column() {
                  Text('📊').fontSize(36).margin({ bottom: 8 })
                  Text('暂无净值数据').fontSize(13).fontColor('#64748b')
                }
                .width('100%')
                .height(220)
                .justifyContent(FlexAlign.Center)
                .alignItems(HorizontalAlign.Center)
              } else {
                LineChart({
                  values: this.getCumulativeValues(),
                  labels: this.getChartLabels(),
                  lineColor: '#3b82f6',
                  secondaryValues: this.getYearValues(),
                  secondaryColor: '#f59e0b',
                  primaryLegend: '累计净值',
                  secondaryLegend: '当年净值',
                })
              }
            }
            .width('100%')
            .padding(16)
            .backgroundColor('#1e293b')
            .borderRadius(12)
            .margin({ bottom: 12 })

            // 明细列表
            if (this.navSeries.length > 0) {
              Column() {
                Text('每日净值明细')
                  .fontSize(15)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#e2e8f0')
                  .margin({ bottom: 8 })

                // 表头
                Row() {
                  Text('日期')
                    .fontSize(12)
                    .fontColor('#64748b')
                    .layoutWeight(1)
                  Text('累计净值')
                    .fontSize(12)
                    .fontColor('#64748b')
                    .width(75)
                    .textAlign(TextAlign.End)
                  Text('当年净值')
                    .fontSize(12)
                    .fontColor('#64748b')
                    .width(75)
                    .textAlign(TextAlign.End)
                  Text('份额')
                    .fontSize(12)
                    .fontColor('#64748b')
                    .width(80)
                    .textAlign(TextAlign.End)
                }
                .width('100%')
                .padding({ bottom: 8, left: 4, right: 4 })

                ForEach(this.navSeries, (point: NavSeriesPoint) => {
                  Row() {
                    Text(point.label)
                      .fontSize(13)
                      .fontColor('#e2e8f0')
                      .layoutWeight(1)
                    Text(point.cumulativeNav !== null
                      ? FormatUtil.formatDecimal(point.cumulativeNav, 4)
                      : '--')
                      .fontSize(13)
                      .fontColor('#3b82f6')
                      .width(75)
                      .textAlign(TextAlign.End)
                    Text(point.yearNav !== null
                      ? FormatUtil.formatDecimal(point.yearNav, 4)
                      : '--')
                      .fontSize(13)
                      .fontColor('#f59e0b')
                      .width(75)
                      .textAlign(TextAlign.End)
                    Text(point.shares !== null
                      ? FormatUtil.formatDecimal(point.shares, 2)
                      : '--')
                      .fontSize(13)
                      .fontColor('#94a3b8')
                      .width(80)
                      .textAlign(TextAlign.End)
                  }
                  .width('100%')
                  .padding({ top: 8, bottom: 8, left: 4, right: 4 })
                  .border({ width: { bottom: 1 }, color: { bottom: '#334155' } })
                })
              }
              .width('100%')
              .padding(16)
              .backgroundColor('#1e293b')
              .borderRadius(12)
              .margin({ bottom: 16 })
            }
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 16 })
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }

      // 底部导航栏
      BottomNav({ currentPage: 'NavAnalysis' })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0f172a')
  }
}
