/**
 * Register — 注册页
 *
 * 邮箱 + 密码 + 昵称（可选）注册。
 * 注册成功后提示并返回登录页。
 */

import { router, promptAction } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';

@Entry
@Component
struct Register {
  @State email: string = '';
  @State password: string = '';
  @State confirmPassword: string = '';
  @State name: string = '';
  @State isLoading: boolean = false;
  @State errorMessage: string = '';

  /**
   * 表单校验
   */
  private validateForm(): boolean {
    if (this.email.trim().length === 0) {
      this.errorMessage = '请输入邮箱';
      return false;
    }
    const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(this.email.trim())) {
      this.errorMessage = '邮箱格式不正确';
      return false;
    }
    if (this.password.length < 6) {
      this.errorMessage = '密码至少 6 位';
      return false;
    }
    if (this.password !== this.confirmPassword) {
      this.errorMessage = '两次输入的密码不一致';
      return false;
    }
    this.errorMessage = '';
    return true;
  }

  /**
   * 执行注册
   */
  private async handleRegister(): Promise<void> {
    if (!this.validateForm()) {
      return;
    }

    this.isLoading = true;
    try {
      const nameParam: string | undefined = this.name.trim().length > 0 ? this.name.trim() : undefined;
      await AuthStore.register(this.email.trim(), this.password, nameParam);
      promptAction.showToast({ message: '注册成功，请登录', duration: 2000 });
      router.back();
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '注册失败';
      this.errorMessage = msg;
      promptAction.showToast({ message: msg, duration: 2000 });
    } finally {
      this.isLoading = false;
    }
  }

  build(): void {
    Column() {
      // 标题
      Text('创建账户')
        .fontSize(26)
        .fontWeight(FontWeight.Bold)
        .fontColor('#e2e8f0')
        .margin({ top: 60, bottom: 32 })

      // 邮箱
      Column() {
        Text('邮箱')
          .fontSize(13)
          .fontColor('#94a3b8')
          .margin({ bottom: 6 })
        TextInput({ text: this.email, placeholder: '请输入邮箱' })
          .width('100%')
          .height(48)
          .fontSize(16)
          .fontColor('#e2e8f0')
          .backgroundColor('#1e293b')
          .borderRadius(8)
          .padding({ left: 12, right: 12 })
          .onChange((value: string) => {
            this.email = value;
          })
      }
      .width('100%')
      .margin({ bottom: 14 })

      // 密码
      Column() {
        Text('密码')
          .fontSize(13)
          .fontColor('#94a3b8')
          .margin({ bottom: 6 })
        TextInput({ text: this.password, placeholder: '至少 6 位' })
          .width('100%')
          .height(48)
          .fontSize(16)
          .fontColor('#e2e8f0')
          .backgroundColor('#1e293b')
          .borderRadius(8)
          .padding({ left: 12, right: 12 })
          .type(InputType.Password)
          .onChange((value: string) => {
            this.password = value;
          })
      }
      .width('100%')
      .margin({ bottom: 14 })

      // 确认密码
      Column() {
        Text('确认密码')
          .fontSize(13)
          .fontColor('#94a3b8')
          .margin({ bottom: 6 })
        TextInput({ text: this.confirmPassword, placeholder: '再次输入密码' })
          .width('100%')
          .height(48)
          .fontSize(16)
          .fontColor('#e2e8f0')
          .backgroundColor('#1e293b')
          .borderRadius(8)
          .padding({ left: 12, right: 12 })
          .type(InputType.Password)
          .onChange((value: string) => {
            this.confirmPassword = value;
          })
      }
      .width('100%')
      .margin({ bottom: 14 })

      // 昵称（可选）
      Column() {
        Text('昵称（可选）')
          .fontSize(13)
          .fontColor('#94a3b8')
          .margin({ bottom: 6 })
        TextInput({ text: this.name, placeholder: '请输入昵称' })
          .width('100%')
          .height(48)
          .fontSize(16)
          .fontColor('#e2e8f0')
          .backgroundColor('#1e293b')
          .borderRadius(8)
          .padding({ left: 12, right: 12 })
          .onChange((value: string) => {
            this.name = value;
          })
      }
      .width('100%')
      .margin({ bottom: 8 })

      // 错误提示
      if (this.errorMessage.length > 0) {
        Text(this.errorMessage)
          .fontSize(13)
          .fontColor('#ef4444')
          .margin({ bottom: 8 })
      }

      // 注册按钮
      Button(this.isLoading ? '注册中...' : '注册')
        .width('100%')
        .height(48)
        .fontSize(16)
        .fontColor('#ffffff')
        .backgroundColor('#3b82f6')
        .borderRadius(8)
        .enabled(!this.isLoading)
        .margin({ top: 8 })
        .onClick(() => {
          this.handleRegister();
        })

      // 返回登录
      Row() {
        Text('已有账户？')
          .fontSize(14)
          .fontColor('#94a3b8')
        Text('返回登录')
          .fontSize(14)
          .fontColor('#3b82f6')
          .fontWeight(FontWeight.Medium)
          .onClick(() => {
            router.back();
          })
      }
      .margin({ top: 20 })
    }
    .width('100%')
    .height('100%')
    .padding({ left: 24, right: 24 })
    .backgroundColor('#0f172a')
    .alignItems(HorizontalAlign.Center)
  }
}
