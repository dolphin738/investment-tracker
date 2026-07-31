/**
 * XirrAnalysis — XIRR 收益分析页
 *
 * 功能：
 * - 四维度切换（日/周/月/年）
 * - XIRR 折线趋势图（Canvas 自绘）
 * - 年度 XIRR 柱状图
 * - 明细数据列表（日期 / XIRR / 环比变化）
 */

import { router, promptAction } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';
import { PortfolioStore } from '../common/store/portfolio-store';
import { QueryApi } from '../common/api/query-api';
import { ApiConfig } from '../common/net/api-config';
import { FormatUtil } from '../common/utils/format';
import { DateUtil } from '../common/utils/date';
import { LineChart } from '../components/LineChart';
import { BarChart } from '../components/BarChart';
import { EmptyState } from '../components/EmptyState';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { BottomNav } from '../components/BottomNav';
import type { Portfolio, XirrSeriesPoint, LatestXirr } from '../common/net/api-types';

@Entry
@Component
struct XirrAnalysis {
  @StorageLink(ApiConfig.PORTFOLIO_KEY) @Watch('onPortfolioChange') currentPortfolioId: string = '';
  @State portfolios: Portfolio[] = [];
  @State currentGranularity: string = 'month';
  @State xirrSeries: XirrSeriesPoint[] = [];
  @State yearlySeries: XirrSeriesPoint[] = [];
  @State latestXirr: LatestXirr | null = null;
  @State isLoading: boolean = false;
  @State isLoadingYearly: boolean = false;

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

  /**
   * 加载所有数据
   */
  private async loadAllData(): Promise<void> {
    this.loadXirrSeries();
    this.loadYearlySeries();
    this.loadLatestXirr();
  }

  /**
   * 加载 XIRR 时间序列
   */
  private async loadXirrSeries(): Promise<void> {
    this.isLoading = true;
    try {
      const range = DateUtil.getDefaultRange(this.currentGranularity);
      this.xirrSeries = await QueryApi.getXirrSeries(
        this.currentPortfolioId,
        this.currentGranularity,
        range.startDate,
        range.endDate,
      );
    } catch (error) {
      this.xirrSeries = [];
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 加载年度数据（用于柱状图）
   */
  private async loadYearlySeries(): Promise<void> {
    this.isLoadingYearly = true;
    try {
      const range = DateUtil.getDefaultRange('year');
      this.yearlySeries = await QueryApi.getXirrSeries(
        this.currentPortfolioId,
        'year',
        range.startDate,
        range.endDate,
      );
    } catch (error) {
      this.yearlySeries = [];
    } finally {
      this.isLoadingYearly = false;
    }
  }

  /**
   * 加载最新 XIRR
   */
  private async loadLatestXirr(): Promise<void> {
    try {
      this.latestXirr = await QueryApi.getLatestXirr(this.currentPortfolioId);
    } catch (error) {
      this.latestXirr = null;
    }
  }

  /**
   * 切换粒度
   */
  private switchGranularity(g: string): void {
    if (g === this.currentGranularity) return;
    this.currentGranularity = g;
    this.loadXirrSeries();
  }

  /**
   * 获取折线图 Y 值
   */
  private getChartValues(): Array<number | null> {
    const result: Array<number | null> = [];
    for (let i = 0; i < this.xirrSeries.length; i++) {
      result.push(this.xirrSeries[i].xirrValue);
    }
    return result;
  }

  /**
   * 获取折线图 X 轴标签
   */
  private getChartLabels(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.xirrSeries.length; i++) {
      result.push(this.xirrSeries[i].label);
    }
    return result;
  }

  /**
   * 获取柱状图数值（百分比形式）
   */
  private getBarValues(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.yearlySeries.length; i++) {
      const val = this.yearlySeries[i].xirrValue;
      result.push(val !== null ? val * 100 : 0);
    }
    return result;
  }

  /**
   * 获取柱状图标签
   */
  private getBarLabels(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.yearlySeries.length; i++) {
      result.push(this.yearlySeries[i].label);
    }
    return result;
  }

  /**
   * 计算环比变化
   */
  private getChange(index: number): number | null {
    if (index === 0 || index >= this.xirrSeries.length) return null;
    const curr = this.xirrSeries[index].xirrValue;
    const prev = this.xirrSeries[index - 1].xirrValue;
    if (curr === null || prev === null) return null;
    return curr - prev;
  }

  build(): void {
    Column() {
      // 顶部标题栏
      Row() {
        Text('XIRR 收益分析')
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
            // 当前 XIRR 摘要
            Row() {
              Column() {
                Text('当前累计 XIRR')
                  .fontSize(13)
                  .fontColor('#94a3b8')
                Text(this.latestXirr && this.latestXirr.xirrValue !== null
                  ? FormatUtil.formatPercent(this.latestXirr.xirrValue)
                  : '--')
                  .fontSize(28)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.latestXirr && this.latestXirr.xirrValue !== null && this.latestXirr.xirrValue >= 0 ? '#22c55e' : '#ef4444')
                  .margin({ top: 4 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              if (this.latestXirr) {
                Column() {
                  Text('最新日期')
                    .fontSize(13)
                    .fontColor('#94a3b8')
                  Text(this.latestXirr.date)
                    .fontSize(15)
                    .fontColor('#e2e8f0')
                    .margin({ top: 4 })
                }
                .alignItems(HorizontalAlign.End)
              }
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

            // XIRR 折线图
            Column() {
              Text(`XIRR 趋势（${DateUtil.getGranularityLabel(this.currentGranularity)}）`)
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
              } else if (this.xirrSeries.length === 0) {
                Column() {
                  Text('📈').fontSize(36).margin({ bottom: 8 })
                  Text('暂无 XIRR 数据').fontSize(13).fontColor('#64748b')
                }
                .width('100%')
                .height(220)
                .justifyContent(FlexAlign.Center)
                .alignItems(HorizontalAlign.Center)
              } else {
                LineChart({
                  values: this.getChartValues(),
                  labels: this.getChartLabels(),
                  lineColor: '#f59e0b',
                  ySuffix: '%',
                  primaryLegend: '累计XIRR',
                })
              }
            }
            .width('100%')
            .padding(16)
            .backgroundColor('#1e293b')
            .borderRadius(12)
            .margin({ bottom: 12 })

            // 年度柱状图
            Column() {
              Text('年度 XIRR 对比')
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .fontColor('#e2e8f0')
                .margin({ bottom: 8 })

              if (this.isLoadingYearly) {
                Column() {
                  LoadingProgress().width(36).height(36).color('#3b82f6')
                }
                .width('100%')
                .height(200)
                .justifyContent(FlexAlign.Center)
                .alignItems(HorizontalAlign.Center)
              } else if (this.yearlySeries.length === 0) {
                Column() {
                  Text('📊').fontSize(36).margin({ bottom: 8 })
                  Text('暂无年度数据').fontSize(13).fontColor('#64748b')
                }
                .width('100%')
                .height(200)
                .justifyContent(FlexAlign.Center)
                .alignItems(HorizontalAlign.Center)
              } else {
                BarChart({
                  values: this.getBarValues(),
                  labels: this.getBarLabels(),
                  positiveColor: '#22c55e',
                  negativeColor: '#ef4444',
                  valueSuffix: '%',
                })
              }
            }
            .width('100%')
            .padding(16)
            .backgroundColor('#1e293b')
            .borderRadius(12)
            .margin({ bottom: 12 })

            // 明细列表
            if (this.xirrSeries.length > 0) {
              Column() {
                Text('明细数据')
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
                  Text('XIRR')
                    .fontSize(12)
                    .fontColor('#64748b')
                    .width(80)
                    .textAlign(TextAlign.End)
                  Text('环比变化')
                    .fontSize(12)
                    .fontColor('#64748b')
                    .width(70)
                    .textAlign(TextAlign.End)
                }
                .width('100%')
                .padding({ bottom: 8, left: 4, right: 4 })

                ForEach(this.xirrSeries, (point: XirrSeriesPoint, index: number) => {
                  Row() {
                    Text(point.label)
                      .fontSize(13)
                      .fontColor('#e2e8f0')
                      .layoutWeight(1)
                    Text(point.xirrValue !== null
                      ? FormatUtil.formatPercent(point.xirrValue)
                      : '--')
                      .fontSize(13)
                      .fontColor(point.xirrValue !== null && point.xirrValue >= 0 ? '#22c55e' : '#ef4444')
                      .width(80)
                      .textAlign(TextAlign.End)
                    Text(FormatUtil.formatPP(this.getChange(index)))
                      .fontSize(13)
                      .fontColor(this.getChange(index) !== null && this.getChange(index)! >= 0 ? '#22c55e' : '#ef4444')
                      .width(70)
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
      BottomNav({ currentPage: 'XirrAnalysis' })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0f172a')
  }
}
