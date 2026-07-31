/**
 * EntryAbility — 应用入口 Ability（Stage 模型）
 *
 * 实现 UIAbility 生命周期回调：
 * - onCreate：Ability 创建时调用（初始化 AuthStore，加载持久化 token）
 * - onWindowStageCreate：窗口创建时调用（加载首页 Index）
 * - onWindowStageDestroy：窗口销毁时调用
 * - onForeground：Ability 切到前台
 * - onBackground：Ability 切到后台
 *
 * T05：集成 AuthStore 初始化 + 完整页面路由。
 */

import { UIAbility, AbilityConstant, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { AuthStore } from '../common/store/auth-store';

const DOMAIN: number = 0x0001;
const TAG: string = 'EntryAbility';

export default class EntryAbility extends UIAbility {
  /**
   * Ability 创建时调用 — 初始化认证状态
   */
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate: 应用创建');
    // 初始化 AuthStore，从持久化存储加载 token 和用户信息到 AppStorage
    AuthStore.init(this.context);
  }

  /**
   * 窗口阶段创建时调用 — 加载首页
   * Index 页面会根据登录状态自动跳转到 Login 或 Dashboard
   */
  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageCreate: 窗口创建，加载首页');

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, `加载首页失败: ${JSON.stringify(err)}`);
        return;
      }
      hilog.info(DOMAIN, TAG, '首页加载成功');
    });
  }

  /**
   * 窗口阶段销毁时调用
   */
  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy: 窗口销毁');
  }

  /**
   * Ability 切到前台时调用
   */
  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground: 应用切到前台');
  }

  /**
   * Ability 切到后台时调用
   */
  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground: 应用切到后台');
  }
}
