/**
 * AccountPendingDeletionException — 账户处于注销冷静期（SYS-P1-02）
 *
 * 登录时命中「邮箱存在 + 密码正确 + 已软删且未满保留期」三条件时抛出，
 * 用于向登录页发出「可自助恢复」的信号，而非一个普通的登录失败。
 *
 * 契约要点：
 * - HTTP 409（Conflict）：**刻意不用 401**。前端 api-client 拦截器对任何 401
 *   都会清 token + 弹「登录已失效」+ 跳转登录页，用 401 会把这个信号吃掉。
 * - 业务码 1007（BUSINESS_ERROR_CODE.PENDING_DELETION）。
 * - 响应体携带 data: { remainingDays }，由全局 HttpExceptionFilter 的
 *   extractCustomData() 透传给前端；前端直接展示，不自行计算（PRD §7.10）。
 *
 * 安全前提：只有 bcrypt 校验通过后才允许抛出本异常。密码不通过的一切路径
 * （含账户确在冷静期）必须统一走 1001 通用文案，避免账户枚举。
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import {
  BUSINESS_ERROR_CODE,
  type AccountPendingDeletionData,
} from '@investment-tracker/shared';

export class AccountPendingDeletionException extends HttpException {
  /**
   * @param remainingDays 冷静期剩余天数（向上取整，最小 1 天）
   */
  constructor(remainingDays: number) {
    const data: AccountPendingDeletionData = { remainingDays };
    super(
      {
        code: BUSINESS_ERROR_CODE.PENDING_DELETION,
        message: '账户处于注销冷静期，请在登录页恢复',
        data,
      },
      HttpStatus.CONFLICT,
    );
  }
}
