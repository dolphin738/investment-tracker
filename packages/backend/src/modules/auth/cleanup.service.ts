/**
 * 软删除用户定时清理服务（SET-P1-06「到期后彻底删除」）
 *
 * 配套 auth.service.deleteAccount 的软删除语义：
 * - deleteAccount 仅置 deletedAt = now，子数据保留在库中（30 天内可恢复）；
 * - 本服务每天凌晨 4 点执行 purgeSoftDeletedUsers()，彻底删除 soft-delete
 *   超过 30 天的用户；
 * - 子数据（组合 / 现金流 / 证券 / 交易 / 快照 / 净值 / XIRR 等）依赖
 *   Prisma schema 的 onDelete: Cascade 一并清理，无需逐表手动删除。
 *
 * 调度由 @nestjs/schedule 的 @Cron 驱动（ScheduleModule.forRoot() 在
 * AuthModule 注册），若部署环境不允许进程内定时器，可改为外部 cron 调用
 * 本 service 的 purgeSoftDeletedUsers()（幂等，重复执行无副作用）。
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ACCOUNT_RETENTION_MS } from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';

// 软删除保留窗口（30 天）统一取 shared 的 ACCOUNT_RETENTION_MS：
// 本服务的跑批口径必须与 AuthService.login / restoreAccount 的按期判定同源，
// 否则会出现「登录说还能恢复、跑批却已删库」这类不一致（SYS-P1-02）。

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 彻底删除 soft-delete 超过 30 天的用户及其全部级联子数据。
   *
   * 每天凌晨 4 点由 @Cron 触发；也可由外部 cron / 内部端点直接调用。
   *
   * @returns 本次删除的用户数量
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeSoftDeletedUsers(): Promise<number> {
    const cutoff = new Date(Date.now() - ACCOUNT_RETENTION_MS);

    const { count } = await this.prisma.user.deleteMany({
      where: {
        deletedAt: {
          lt: cutoff,
        },
      },
    });

    if (count > 0) {
      this.logger.log(
        `已彻底删除 ${count} 个 soft-delete 超过 30 天的用户（cutoff=${cutoff.toISOString()}）`,
      );
    } else {
      this.logger.debug(
        `无可清理的 soft-delete 用户（cutoff=${cutoff.toISOString()}）`,
      );
    }

    return count;
  }
}
