/**
 * Transactions — 交易记录页
 *
 * 功能：
 * - 交易列表（日期 / 类型 / 金额 / 备注）
 * - 底部弹窗录入新交易
 * - 编辑现有交易
 * - 删除交易（确认对话框）
 * - 类型筛选：买入 / 卖出
 */

import { router, promptAction } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';
import { PortfolioStore } from '../common/store/portfolio-store';
import { TransactionApi } from '../common/api/transaction-api';
import { ApiConfig } from '../common/net/api-config';
import { FormatUtil } from '../common/utils/format';
import { DateUtil } from '../common/utils/date';
import { TransactionType } from '../common/net/api-types';
import type { Transaction, Paginated, Portfolio } from '../common/net/api-types';
import { EmptyState } from '../components/EmptyState';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { BottomNav } from '../components/BottomNav';

@Entry
@Component
struct Transactions {
  @StorageLink(ApiConfig.PORTFOLIO_KEY) @Watch('onPortfolioChange') currentPortfolioId: string = '';
  @State portfolios: Portfolio[] = [];
  @State transactions: Transaction[] = [];
  @State isLoading: boolean = false;

  // 表单状态
  @State showForm: boolean = false;
  @State editingId: string = '';
  @State formDate: string = '';
  @State formType: string = TransactionType.BUY;
  @State formAmount: string = '';
  @State formNote: string = '';
  @State isSubmitting: boolean = false;

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
        await this.loadTransactions();
      }
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '加载失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    }
  }

  /**
   * 组合切换时重新加载
   */
  onPortfolioChange(): void {
    if (this.currentPortfolioId.length > 0) {
      this.loadTransactions();
    }
  }

  /**
   * 加载交易列表
   */
  private async loadTransactions(): Promise<void> {
    if (this.currentPortfolioId.length === 0) return;
    this.isLoading = true;
    try {
      const result: Paginated<Transaction> = await TransactionApi.list(
        this.currentPortfolioId, 1, 100,
      );
      this.transactions = result.items;
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '加载交易失败';
      promptAction.showToast({ message: msg, duration: 2000 });
      this.transactions = [];
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 打开新建表单
   */
  private openCreateForm(): void {
    this.editingId = '';
    this.formDate = DateUtil.today();
    this.formType = TransactionType.BUY;
    this.formAmount = '';
    this.formNote = '';
    this.showForm = true;
  }

  /**
   * 打开编辑表单
   */
  private openEditForm(tx: Transaction): void {
    this.editingId = tx.id;
    this.formDate = tx.date;
    this.formType = tx.type;
    this.formAmount = tx.amount;
    this.formNote = tx.note || '';
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
      },
    });
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
    const amountNum: number = parseFloat(this.formAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      promptAction.showToast({ message: '金额必须大于 0', duration: 1500 });
      return false;
    }
    return true;
  }

  /**
   * 提交表单（新建或编辑）
   */
  private async handleSubmit(): Promise<void> {
    if (!this.validateForm()) return;

    this.isSubmitting = true;
    try {
      // 格式化金额为两位小数字符串
      const amountStr: string = parseFloat(this.formAmount).toFixed(2);

      if (this.editingId.length > 0) {
        // 编辑模式
        await TransactionApi.update(this.currentPortfolioId, this.editingId, {
          date: this.formDate,
          type: this.formType as TransactionType,
          amount: amountStr,
          note: this.formNote.trim().length > 0 ? this.formNote.trim() : undefined,
        });
        promptAction.showToast({ message: '修改成功', duration: 1500 });
      } else {
        // 新建模式
        await TransactionApi.create(
          this.currentPortfolioId,
          this.formDate,
          this.formType as TransactionType,
          amountStr,
          this.formNote.trim().length > 0 ? this.formNote.trim() : undefined,
        );
        promptAction.showToast({ message: '录入成功', duration: 1500 });
      }

      this.showForm = false;
      await this.loadTransactions();
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '操作失败';
      promptAction.showToast({ message: msg, duration: 2000 });
    } finally {
      this.isSubmitting = false;
    }
  }

  /**
   * 删除交易（带确认）
   */
  private async handleDelete(tx: Transaction): Promise<void> {
    try {
      const result = await promptAction.showDialog({
        title: '确认删除',
        message: `确定要删除 ${tx.date} 的交易记录吗？`,
        buttons: [
          { text: '取消', color: '#94a3b8' },
          { text: '删除', color: '#ef4444' },
        ],
      });
      if (result.index === 1) {
        await TransactionApi.delete(this.currentPortfolioId, tx.id);
        promptAction.showToast({ message: '已删除', duration: 1500 });
        await this.loadTransactions();
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
          Text('交易记录')
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

        // 交易列表
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
        } else if (this.transactions.length === 0) {
          EmptyState({ message: '暂无交易记录', subtitle: '点击下方按钮录入第一笔交易', icon: '💰' })
            .layoutWeight(1)
        } else {
          Scroll() {
            Column() {
              ForEach(this.transactions, (tx: Transaction) => {
                Row() {
                  // 日期 + 类型
                  Column() {
                    Text(tx.date)
                      .fontSize(14)
                      .fontColor('#e2e8f0')
                      .fontWeight(FontWeight.Medium)
                    Row() {
                      Text(tx.type === TransactionType.BUY ? '买入' : '卖出')
                        .fontSize(11)
                        .fontColor(tx.type === TransactionType.BUY ? '#22c55e' : '#f59e0b')
                        .padding({ left: 6, right: 6, top: 1, bottom: 1 })
                        .backgroundColor(tx.type === TransactionType.BUY ? '#22c55e20' : '#f59e0b20')
                        .borderRadius(4)
                    }
                    .margin({ top: 4 })
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)

                  // 金额
                  Column() {
                    Text(FormatUtil.formatCurrency(tx.amount))
                      .fontSize(15)
                      .fontColor('#e2e8f0')
                      .fontWeight(FontWeight.Medium)
                    if (tx.note && tx.note.length > 0) {
                      Text(tx.note)
                        .fontSize(12)
                        .fontColor('#64748b')
                        .margin({ top: 2 })
                        .maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                    }
                  }
                  .alignItems(HorizontalAlign.End)

                  // 操作按钮
                  Column() {
                    Text('编辑')
                      .fontSize(13)
                      .fontColor('#3b82f6')
                      .padding({ top: 4, bottom: 4 })
                      .onClick(() => {
                        this.openEditForm(tx);
                      })
                    Text('删除')
                      .fontSize(13)
                      .fontColor('#ef4444')
                      .padding({ top: 4, bottom: 4 })
                      .onClick(() => {
                        this.handleDelete(tx);
                      })
                  }
                  .alignItems(HorizontalAlign.End)
                  .margin({ left: 8 })
                }
                .width('100%')
                .padding({ left: 16, right: 16, top: 12, bottom: 12 })
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
        Button('+ 录入交易')
          .width('90%')
          .height(44)
          .fontSize(15)
          .fontColor('#ffffff')
          .backgroundColor('#3b82f6')
          .borderRadius(8)
          .margin({ bottom: 8 })
          .enabled(this.currentPortfolioId.length > 0)
          .onClick(() => {
            this.openCreateForm();
          })

        // 底部导航栏
        BottomNav({ currentPage: 'Transactions' })
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
            Text(this.editingId.length > 0 ? '编辑交易' : '录入交易')
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .fontColor('#e2e8f0')
              .margin({ bottom: 16 })

            // 日期选择
            Column() {
              Text('交易日期')
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

            // 交易类型
            Column() {
              Text('交易类型')
                .fontSize(13)
                .fontColor('#94a3b8')
                .margin({ bottom: 6 })
              Row() {
                Button('买入')
                  .layoutWeight(1)
                  .height(44)
                  .fontSize(15)
                  .fontColor(this.formType === TransactionType.BUY ? '#ffffff' : '#94a3b8')
                  .backgroundColor(this.formType === TransactionType.BUY ? '#22c55e' : '#0f172a')
                  .borderRadius(8)
                  .onClick(() => {
                    this.formType = TransactionType.BUY;
                  })

                Button('卖出')
                  .layoutWeight(1)
                  .height(44)
                  .fontSize(15)
                  .fontColor(this.formType === TransactionType.SELL ? '#ffffff' : '#94a3b8')
                  .backgroundColor(this.formType === TransactionType.SELL ? '#f59e0b' : '#0f172a')
                  .borderRadius(8)
                  .margin({ left: 8 })
                  .onClick(() => {
                    this.formType = TransactionType.SELL;
                  })
              }
              .width('100%')
            }
            .width('100%')
            .margin({ bottom: 14 })

            // 金额
            Column() {
              Text('交易金额（元）')
                .fontSize(13)
                .fontColor('#94a3b8')
                .margin({ bottom: 6 })
              TextInput({ text: this.formAmount, placeholder: '请输入金额' })
                .width('100%')
                .height(44)
                .fontSize(16)
                .fontColor('#e2e8f0')
                .backgroundColor('#0f172a')
                .borderRadius(8)
                .padding({ left: 12, right: 12 })
                .inputFilter('[0-9.]')
                .onChange((value: string) => {
                  this.formAmount = value;
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
              TextInput({ text: this.formNote, placeholder: '如：定投、止盈等' })
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
                .backgroundColor('#3b82f6')
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
