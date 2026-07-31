/**
 * Login — 登录页
 *
 * 邮箱 + 密码登录，含切换注册链接。
 * 登录成功后 JWT 存入 AuthStore 并跳转 Dashboard。
 */

import { router, promptAction } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';

@Entry
@Component
struct Login {
  @State email: string = '';
  @State password: string = '';
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
    // 简单邮箱格式校验
    const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(this.email.trim())) {
      this.errorMessage = '邮箱格式不正确';
      return false;
    }
    if (this.password.length === 0) {
      this.errorMessage = '请输入密码';
      return false;
    }
    if (this.password.length < 6) {
      this.errorMessage = '密码至少 6 位';
      return false;
    }
    this.errorMessage = '';
    return true;
  }

  /**
   * 执行登录
   */
  private async handleLogin(): Promise<void> {
    if (!this.validateForm()) {
      return;
    }

    this.isLoading = true;
    try {
      await AuthStore.login(this.email.trim(), this.password);
      promptAction.showToast({ message: '登录成功', duration: 1500 });
      router.replaceUrl({ url: 'pages/Dashboard' });
    } catch (error) {
      const msg: string = error instanceof Error ? error.message : '登录失败';
      this.errorMessage = msg;
      promptAction.showToast({ message: msg, duration: 2000 });
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 跳转注册页
   */
  private goToRegister(): void {
    router.pushUrl({ url: 'pages/Register' });
  }

  build(): void {
    Column() {
      // 标题
      Text('投资收益统计')
        .fontSize(28)
        .fontWeight(FontWeight.Bold)
        .fontColor('#e2e8f0')
        .margin({ top: 80, bottom: 8 })

      Text('登录您的账户')
        .fontSize(15)
        .fontColor('#94a3b8')
        .margin({ bottom: 40 })

      // 邮箱输入
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
          .inputFilter('[a-zA-Z0-9@._-]')
          .onChange((value: string) => {
            this.email = value;
          })
      }
      .width('100%')
      .margin({ bottom: 16 })

      // 密码输入
      Column() {
        Text('密码')
          .fontSize(13)
          .fontColor('#94a3b8')
          .margin({ bottom: 6 })
        TextInput({ text: this.password, placeholder: '请输入密码' })
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
      .margin({ bottom: 8 })

      // 错误提示
      if (this.errorMessage.length > 0) {
        Text(this.errorMessage)
          .fontSize(13)
          .fontColor('#ef4444')
          .margin({ bottom: 8 })
      }

      // 登录按钮
      Button(this.isLoading ? '登录中...' : '登录')
        .width('100%')
        .height(48)
        .fontSize(16)
        .fontColor('#ffffff')
        .backgroundColor('#3b82f6')
        .borderRadius(8)
        .enabled(!this.isLoading)
        .margin({ top: 8 })
        .onClick(() => {
          this.handleLogin();
        })

      // 注册链接
      Row() {
        Text('还没有账户？')
          .fontSize(14)
          .fontColor('#94a3b8')
        Text('立即注册')
          .fontSize(14)
          .fontColor('#3b82f6')
          .fontWeight(FontWeight.Medium)
          .onClick(() => {
            this.goToRegister();
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
