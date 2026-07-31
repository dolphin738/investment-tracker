/**
 * Snapshots — 资产快照页
 *
 * 功能：
 * - 快照列表（日期 / 总资产 / 备注）
 * - 底部弹窗录入快照（PUT upsert 语义）
 * - 覆盖确认（同日已有快照时提示用户）
 * - 删除快照（确认对话框）
 *
 * 注意：快照使用 PUT upsert 语义，同日重复录入会覆盖。
 */

import { router, promptAction } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';
import { PortfolioStore } from '../common/store/portfolio-store';
import { SnapshotApi } from '../common/api/snapshot-api';
import { ApiConfig } from '../common/net/api-config';
import { FormatUtil } from '../common/utils/format';
import { DateUtil } from '../common/utils/date';
import type { AssetSnapshot, Paginated, Portfolio } from '../common/net/api-types';
import { EmptyState } from '../components/EmptyState';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { BottomNav } from '../components/BottomNav';

@Entry
@Component
struct Snapshots {
  @StorageLink(ApiConfig.PORTFOLIO_KEY) @Watch('onPortfolioChange') currentPortfolioId: string = '';
  @State portfolios: Portfolio[] = [];
  @State snapshots: AssetSnapshot[] = [];
  @State isLoading: boolean = false;

  // 表单状态
  @State showForm: boolean = false;
  @State formDate: string = '';
  @State formTotalAsset: string = '';
  @State formNote: string = '';
  @State isSubmitting: boolean = false;
  @State isOverwrite: boolean = false;

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
        await this.loadSnapshots();
      }
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '加载失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    }
  }

  onPortfolioChange(): void {
    if (this.currentPortfolioId.length > 0) {
      this.loadSnapshots();
    }
  }

  /**
   * 加载快照列表
   */
  private async loadSnapshots(): Promise<void> {
    if (this.currentPortfolioId.length === 0) return;
    this.isLoading = true;
    try {
      const result: Paginated<AssetSnapshot> = await SnapshotApi.list(
        this.currentPortfolioId, 1, 100,
      );
      this.snapshots = result.items;
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '加载快照失败';
      promptAction.showToast({ message: msg, duration: 2000 });
      this.snapshots = [];
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 打开录入表单
   */
  private openCreateForm(): void {
    this.formDate = DateUtil.today();
    this.formTotalAsset = '';
    this.formNote = '';
    this.isOverwrite = false;
    this.showForm = true;
  }

  /**
   * 选择日期
   */
  private pickDate(): void {
    DatePickerDialog.show({
      start: new Date('2020-01-01'),
      end: new Date(),
      selected: this.formDate ? DateUtil.stringToDate(this.formDate) : new Date(),
      onAccept: (value: DatePickerResult) => {
        const month: string = (value.month + 1).toString().padStart(2, '0');
        const day: string = value.day.toString().padStart(2, '0');
        this.formDate = `${value.year}-${month}-${day}`;
        // 检查是否已存在该日期的快照
        this.checkOverwrite();
      },
    });
  }

  /**
   * 检查当前日期是否已有快照（用于覆盖提示）
   */
  private checkOverwrite(): void {
    this.isOverwrite = false;
    for (let i = 0; i < this.snapshots.length; i++) {
      if (this.snapshots[i].date === this.formDate) {
        this.isOverwrite = true;
        break;
      }
    }
  }

  /**
   * 表单校验
   */
  private validateForm(): boolean {
    if (this.formDate.length === 0) {
      promptAction.showToast({ message: '请选择日期', duration: 1500 });
      return false;
    }
    if (DateUtil.isFutureDate(this.formDate)) {
      promptAction.showToast({ message: '日期不能为未来日期', duration: 1500 });
      return false;
    }
    const amountNum: number = parseFloat(this.formTotalAsset);
    if (isNaN(amountNum) || amountNum <= 0) {
      promptAction.showToast({ message: '资产总额必须大于 0', duration: 1500 });
      return false;
    }
    return true;
  }

  /**
   * 提交表单（upsert 语义）
   */
  private async handleSubmit(): Promise<void> {
    if (!this.validateForm()) return;

    this.isSubmitting = true;
    try {
      const totalAssetStr: string = parseFloat(this.formTotalAsset).toFixed(2);
      await SnapshotApi.upsert(
        this.currentPortfolioId,
        this.formDate,
        totalAssetStr,
        this.formNote.trim().length > 0 ? this.formNote.trim() : undefined,
      );
      promptAction.showToast({
        message: this.isOverwrite ? '快照已覆盖' : '录入成功',
        duration: 1500,
      });
      this.showForm = false;
      await this.loadSnapshots();
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '操作失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    } finally {
      this.isSubmitting = false;
    }
  }

  /**
   * 删除快照（带确认）
   */
  private async handleDelete(snapshot: AssetSnapshot): Promise<void> {
    try {
      const result = await promptAction.showDialog({
        title: '确认删除',
        message: `确定要删除 ${snapshot.date} 的快照吗？删除后将触发从该日期起的批量重算。`,
        buttons: [
          { text: '取消', color: '#94a3b8' },
          { text: '删除', color: '#ef4444' },
        ],
      });
      if (result.index === 1) {
        await SnapshotApi.delete(this.currentPortfolioId, snapshot.id);
        promptAction.showToast({ message: '已删除', duration: 1500 });
        await this.loadSnapshots();
      }
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '删除失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    }
  }

  build(): void {
    Stack() {
      // ===== 主内容 =====
      Column() {
        // 顶部标题栏
        Row() {
          Text('资产快照')
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

        // 快照列表
        if (this.currentPortfolioId.length === 0) {
          EmptyState({ message: '请先创建投资组合', icon: '💼' })
            .layoutWeight(1)
        } else if (this.isLoading) {
          Column() {
            LoadingProgress().width(36).height(36).color('#3b82f6')
            Text('加载中...').fontSize(13).fontColor('#94a3b8').margin({ top: 8 })
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
          .layoutWeight(1)
        } else if (this.snapshots.length === 0) {
          EmptyState({ message: '暂无快照记录', subtitle: '录入资产快照后将自动计算净值和XIRR', icon: '📷' })
            .layoutWeight(1)
        } else {
          Scroll() {
            Column() {
              ForEach(this.snapshots, (snapshot: AssetSnapshot) => {
                Row() {
                  Column() {
                    Text(snapshot.date)
                      .fontSize(14)
                      .fontColor('#e2e8f0')
                      .fontWeight(FontWeight.Medium)
                    if (snapshot.note && snapshot.note.length > 0) {
                      Text(snapshot.note)
                        .fontSize(12)
                        .fontColor('#64748b')
                        .margin({ top: 4 })
                        .maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                    }
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)

                  // 总资产
                  Text(FormatUtil.formatCurrency(snapshot.totalAsset))
                    .fontSize(16)
                    .fontColor('#e2e8f0')
                    .fontWeight(FontWeight.Medium)

                  // 删除按钮
                  Text('删除')
                    .fontSize(13)
                    .fontColor('#ef4444')
                    .margin({ left: 12 })
                    .onClick(() => {
                      this.handleDelete(snapshot);
                    })
                }
                .width('100%')
                .padding({ left: 16, right: 16, top: 14, bottom: 14 })
                .backgroundColor('#1e293b')
                .borderRadius(8)
                .margin({ bottom: 8 })
              })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 8, bottom: 8 })
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
        }

        // 录入按钮
        Button('+ 录入快照')
          .width('90%')
          .height(44)
          .fontSize(15)
          .fontColor('#ffffff')
          .backgroundColor('#22c55e')
          .borderRadius(8)
          .margin({ bottom: 8 })
          .enabled(this.currentPortfolioId.length > 0)
          .onClick(() => {
            this.openCreateForm();
          })

        // 底部导航栏
        BottomNav({ currentPage: 'Snapshots' })
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#0f172a')

      // ===== 底部弹窗表单 =====
      if (this.showForm) {
        Column() {
          // 半透明遮罩
          Column()
            .width('100%')
            .layoutWeight(1)
            .backgroundColor('#00000080')
            .onClick(() => {
              if (!this.isSubmitting) {
                this.showForm = false;
              }
            })

          // 表单内容
          Column() {
            Text('录入资产快照')
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .fontColor('#e2e8f0')
              .margin({ bottom: 16 })

            // 覆盖提示
            if (this.isOverwrite) {
              Row() {
                Text('⚠ 该日期已有快照，保存将覆盖原数据')
                  .fontSize(13)
                  .fontColor('#f59e0b')
              }
              .width('100%')
              .padding({ left: 12, right: 12, top: 8, bottom: 8 })
              .backgroundColor('#f59e0b20')
              .borderRadius(8)
              .margin({ bottom: 14 })
            }

            // 日期选择
            Column() {
              Text('快照日期')
                .fontSize(13)
                .fontColor('#94a3b8')
                .margin({ bottom: 6 })
              Button(this.formDate.length > 0 ? this.formDate : '选择日期')
                .width('100%')
                .height(44)
                .fontSize(15)
                .fontColor('#e2e8f0')
                .backgroundColor('#0f172a')
                .borderRadius(8)
                .align(Alignment.Start)
                .padding({ left: 12 })
                .onClick(() => {
                  this.pickDate();
                })
            }
            .width('100%')
            .margin({ bottom: 14 })

            // 总资产
            Column() {
              Text('当日总资产（元）')
                .fontSize(13)
                .fontColor('#94a3b8')
                .margin({ bottom: 6 })
              TextInput({ text: this.formTotalAsset, placeholder: '请输入持仓总市值' })
                .width('100%')
                .height(44)
                .fontSize(16)
                .fontColor('#e2e8f0')
                .backgroundColor('#0f172a')
                .borderRadius(8)
                .padding({ left: 12, right: 12 })
                .inputFilter('[0-9.]')
                .onChange((value: string) => {
                  this.formTotalAsset = value;
                })
            }
            .width('100%')
            .margin({ bottom: 14 })

            // 备注
            Column() {
              Text('备注（可选）')
                .fontSize(13)
                .fontColor('#94a3b8')
                .margin({ bottom: 6 })
              TextInput({ text: this.formNote, placeholder: '如：季度估值等' })
                .width('100%')
                .height(44)
                .fontSize(16)
                .fontColor('#e2e8f0')
                .backgroundColor('#0f172a')
                .borderRadius(8)
                .padding({ left: 12, right: 12 })
                .onChange((value: string) => {
                  this.formNote = value;
                })
            }
            .width('100%')
            .margin({ bottom: 20 })

            // 操作按钮
            Row() {
              Button('取消')
                .layoutWeight(1)
                .height(44)
                .fontSize(15)
                .fontColor('#94a3b8')
                .backgroundColor('#0f172a')
                .borderRadius(8)
                .enabled(!this.isSubmitting)
                .onClick(() => {
                  this.showForm = false;
                })

              Button(this.isSubmitting ? '保存中...' : '保存')
                .layoutWeight(1)
                .height(44)
                .fontSize(15)
                .fontColor('#ffffff')
                .backgroundColor('#22c55e')
                .borderRadius(8)
                .margin({ left: 8 })
                .enabled(!this.isSubmitting)
                .onClick(() => {
                  this.handleSubmit();
                })
            }
            .width('100%')
          }
          .width('100%')
          .padding(20)
          .backgroundColor('#1e293b')
          .borderRadius({ topLeft: 16, topRight: 16 })
        }
        .width('100%')
        .height('100%')
      }
    }
    .width('100%')
    .height('100%')
  }
}
