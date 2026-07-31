/**
 * Dashboard — 首页
 *
 * 布局：
 * - 顶部：标题 + 组合选择器
 * - 指标卡片：累计 XIRR / 总收益率 / 当年收益率
 * - 净值趋势折线图
 * - XIRR 趋势折线图
 * - 快捷入口：录入交易 / 录入快照 / 净值分析
 * - 底部导航栏
 */

import { router, promptAction } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';
import { PortfolioStore } from '../common/store/portfolio-store';
import { QueryApi } from '../common/api/query-api';
import { ApiConfig } from '../common/net/api-config';
import { FormatUtil } from '../common/utils/format';
import { DateUtil } from '../common/utils/date';
import { StatCard } from '../components/StatCard';
import { LineChart } from '../components/LineChart';
import { EmptyState } from '../components/EmptyState';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { BottomNav } from '../components/BottomNav';
import type {
  Portfolio,
  XirrSeriesPoint,
  NavSeriesPoint,
  LatestXirr,
  LatestNav,
} from '../common/net/api-types';

@Entry
@Component
struct Dashboard {
  @StorageLink(ApiConfig.PORTFOLIO_KEY) @Watch('onPortfolioChange') currentPortfolioId: string = '';
  @State portfolios: Portfolio[] = [];
  @State latestXirr: LatestXirr | null = null;
  @State latestNav: LatestNav | null = null;
  @State navSeries: NavSeriesPoint[] = [];
  @State xirrSeries: XirrSeriesPoint[] = [];
  @State isLoadingSummary: boolean = false;
  @State isLoadingNav: boolean = false;
  @State isLoadingXirr: boolean = false;

  aboutToAppear(): void {
    this.initPage();
  }

  /**
   * 组合切换时重新加载数据
   */
  onPortfolioChange(): void {
    if (!this.isInitialized) return;
    if (this.currentPortfolioId.length > 0) {
      this.loadAllData();
    }
  }

  private isInitialized: boolean = false;

  private async initPage(): Promise<void> {
    if (!AuthStore.isAuthenticated()) {
      router.replaceUrl({ url: 'pages/Login' });
      return;
    }
    try {
      this.portfolios = await PortfolioStore.listPortfolios();
      const selectedId = await PortfolioStore.ensureSelected();
      if (selectedId.length === 0) {
        return; // 无组合，等待用户创建
      }
      this.currentPortfolioId = selectedId;
      await this.loadAllData();
      this.isInitialized = true;
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '初始化失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    }
  }

  /**
   * 加载所有 Dashboard 数据
   */
  private async loadAllData(): Promise<void> {
    if (this.currentPortfolioId.length === 0) return;
    this.loadSummary();
    this.loadNavChart();
    this.loadXirrChart();
  }

  /**
   * 加载摘要数据（最新 XIRR + 最新净值）
   */
  private async loadSummary(): Promise<void> {
    this.isLoadingSummary = true;
    try {
      const [xirr, nav] = await Promise.all([
        QueryApi.getLatestXirr(this.currentPortfolioId),
        QueryApi.getLatestNav(this.currentPortfolioId),
      ]);
      this.latestXirr = xirr;
      this.latestNav = nav;
    } catch (error) {
      // 静默处理，卡片显示 "--"
    } finally {
      this.isLoadingSummary = false;
    }
  }

  /**
   * 加载净值趋势图（默认按月，最近 12 个月）
   */
  private async loadNavChart(): Promise<void> {
    this.isLoadingNav = true;
    try {
      const range = DateUtil.getDefaultRange('month');
      this.navSeries = await QueryApi.getNavSeries(
        this.currentPortfolioId,
        'month',
        range.startDate,
        range.endDate,
      );
    } catch (error) {
      this.navSeries = [];
    } finally {
      this.isLoadingNav = false;
    }
  }

  /**
   * 加载 XIRR 趋势图（默认按月，最近 12 个月）
   */
  private async loadXirrChart(): Promise<void> {
    this.isLoadingXirr = true;
    try {
      const range = DateUtil.getDefaultRange('month');
      this.xirrSeries = await QueryApi.getXirrSeries(
        this.currentPortfolioId,
        'month',
        range.startDate,
        range.endDate,
      );
    } catch (error) {
      this.xirrSeries = [];
    } finally {
      this.isLoadingXirr = false;
    }
  }

  /**
   * 获取净值图表 Y 值数组（累计净值）
   */
  private getNavValues(): Array<number | null> {
    const result: Array<number | null> = [];
    for (let i = 0; i < this.navSeries.length; i++) {
      result.push(this.navSeries[i].cumulativeNav);
    }
    return result;
  }

  /**
   * 获取净值图表 X 轴标签
   */
  private getNavLabels(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.navSeries.length; i++) {
      result.push(this.navSeries[i].label);
    }
    return result;
  }

  /**
   * 获取 XIRR 图表 Y 值数组
   */
  private getXirrValues(): Array<number | null> {
    const result: Array<number | null> = [];
    for (let i = 0; i < this.xirrSeries.length; i++) {
      result.push(this.xirrSeries[i].xirrValue);
    }
    return result;
  }

  /**
   * 获取 XIRR 图表 X 轴标签
   */
  private getXirrLabels(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.xirrSeries.length; i++) {
      result.push(this.xirrSeries[i].label);
    }
    return result;
  }

  build(): void {
    Column() {
      // 顶部标题栏
      Row() {
        Text('投资收益统计')
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

      // 内容区域
      Scroll() {
        Column() {
          // 组合选择器
          Column() {
            PortfolioSelector({ portfolios: this.portfolios })
          }
          .width('100%')
          .margin({ top: 12 })

          if (this.currentPortfolioId.length === 0) {
            EmptyState({
              message: '暂无投资组合',
              subtitle: '请在设置页面创建组合',
              icon: '💼',
            })
          } else {
            // 指标卡片
            Row() {
              StatCard({
                title: '累计 XIRR',
                value: this.latestXirr && this.latestXirr.xirrValue !== null
                  ? FormatUtil.formatPercent(this.latestXirr.xirrValue)
                  : '--',
                subtitle: this.latestXirr ? this.latestXirr.date : '',
                valueColor: this.latestXirr && this.latestXirr.xirrValue !== null && this.latestXirr.xirrValue >= 0 ? '#22c55e' : '#ef4444',
              })
                .layoutWeight(1)

              StatCard({
                title: '总收益率',
                value: this.latestNav && this.latestNav.cumulativeNav !== null
                  ? FormatUtil.formatPercent(this.latestNav.cumulativeNav - 1)
                  : '--',
                subtitle: this.latestNav ? this.latestNav.date : '',
                valueColor: this.latestNav && this.latestNav.cumulativeNav !== null && this.latestNav.cumulativeNav >= 1 ? '#22c55e' : '#ef4444',
              })
                .layoutWeight(1)
                .margin({ left: 8 })
            }
            .width('100%')
            .margin({ top: 12 })

            Row() {
              StatCard({
                title: '当年收益率',
                value: this.latestNav && this.latestNav.yearNav !== null
                  ? FormatUtil.formatPercent(this.latestNav.yearNav - 1)
                  : '--',
                subtitle: '较年初',
                valueColor: this.latestNav && this.latestNav.yearNav !== null && this.latestNav.yearNav >= 1 ? '#22c55e' : '#ef4444',
              })
                .layoutWeight(1)

              StatCard({
                title: '当前份额',
                value: this.latestNav && this.latestNav.shares !== null
                  ? FormatUtil.formatDecimal(this.latestNav.shares, 2)
                  : '--',
                subtitle: '份',
              })
                .layoutWeight(1)
                .margin({ left: 8 })
            }
            .width('100%')
            .margin({ top: 8 })

            // 净值趋势图
            Column() {
              Text('净值趋势（按月）')
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .fontColor('#e2e8f0')
                .margin({ bottom: 8 })

              if (this.isLoadingNav) {
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
                  values: this.getNavValues(),
                  labels: this.getNavLabels(),
                  lineColor: '#3b82f6',
                  primaryLegend: '累计净值',
                })
              }
            }
            .width('100%')
            .padding(16)
            .backgroundColor('#1e293b')
            .borderRadius(12)
            .margin({ top: 16 })

            // XIRR 趋势图
            Column() {
              Text('XIRR 趋势（按月）')
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .fontColor('#e2e8f0')
                .margin({ bottom: 8 })

              if (this.isLoadingXirr) {
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
                  values: this.getXirrValues(),
                  labels: this.getXirrLabels(),
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
            .margin({ top: 12 })

            // 快捷入口
            Row() {
              Button('录入交易')
                .layoutWeight(1)
                .height(44)
                .fontSize(14)
                .fontColor('#ffffff')
                .backgroundColor('#3b82f6')
                .borderRadius(8)
                .onClick(() => {
                  router.pushUrl({ url: 'pages/Transactions' });
                })

              Button('录入快照')
                .layoutWeight(1)
                .height(44)
                .fontSize(14)
                .fontColor('#ffffff')
                .backgroundColor('#22c55e')
                .borderRadius(8)
                .margin({ left: 8 })
                .onClick(() => {
                  router.pushUrl({ url: 'pages/Snapshots' });
                })

              Button('净值分析')
                .layoutWeight(1)
                .height(44)
                .fontSize(14)
                .fontColor('#3b82f6')
                .backgroundColor('#1e293b')
                .border({ width: 1, color: '#3b82f6' })
                .borderRadius(8)
                .margin({ left: 8 })
                .onClick(() => {
                  router.pushUrl({ url: 'pages/NavAnalysis' });
                })
            }
            .width('100%')
            .margin({ top: 16, bottom: 16 })
          }
        }
        .width('100%')
        .padding({ left: 16, right: 16 })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)

      // 底部导航栏
      BottomNav({ currentPage: 'Dashboard' })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0f172a')
  }
}
