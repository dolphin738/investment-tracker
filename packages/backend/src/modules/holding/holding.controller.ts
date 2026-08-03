/**
 * 持仓只读控制器（方案B · 交易明细法）
 *
 * 路由前缀：/api/portfolios/:portfolioId/holdings
 *
 * 接口：
 * - GET /api/portfolios/:portfolioId/holdings — 实时推导持仓列表 + 汇总
 *
 * 设计要点：
 * - 只读：持仓不落库，由 HoldingDerivationService 按 SecurityTrade 流水实时推导。
 * - 数据隔离：先校验 portfolio 属于当前用户（与 OverviewService 同款 findFirst 校验）。
 * - 查询参数：
 *   - date（YYYY-MM-DD，可选）：推导目标日期，缺省为今天
 *   - securityId（可选）：仅返回该标的
 *   - includeClosed（可选）：是否包含已清仓标的（qty === 0）
 * - 返回 { items: HoldingView[], aggregate: HoldingsAggregate }，
 *   ResponseInterceptor 会统一包装为 { code, data, message } 信封。
 */

import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { HoldingDerivationService, HoldingView } from './holding-derivation.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/** 持仓汇总（总市值/总成本/总盈亏/总盈亏率/标的数） */
export interface HoldingsAggregate {
  /** 总市值 */
  totalMarketValue: number;
  /** 总成本 */
  totalCost: number;
  /** 总浮动盈亏 */
  totalProfit: number;
  /** 总盈亏率 = totalProfit / totalCost，成本为 0 时为 0 */
  totalProfitRate: number;
  /** 持仓标的数 */
  securityCount: number;
}

/** 将 YYYY-MM-DD 解析为本地日期（避免 UTC 偏移导致跨日） */
function parseDateParam(value: string | undefined): Date {
  if (!value) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const parts = value.split('-').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
    throw new BadRequestException(`无效日期参数: ${value}`);
  }
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

@ApiTags('持仓（方案B 实时推导）')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/holdings')
export class HoldingController {
  constructor(
    private readonly holdingDerivationService: HoldingDerivationService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: '获取组合实时持仓（由 SecurityTrade 流水推导，只读）' })
  @ApiQuery({ name: 'date', required: false, description: '推导日期 YYYY-MM-DD，缺省为今天' })
  @ApiQuery({ name: 'securityId', required: false, description: '仅返回该标的的持仓' })
  @ApiQuery({ name: 'includeClosed', required: false, description: '是否包含已清仓标的' })
  async getHoldings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query('date') date?: string,
    @Query('securityId') securityId?: string,
    @Query('includeClosed') includeClosed?: string,
  ): Promise<{ items: HoldingView[]; aggregate: HoldingsAggregate }> {
    // 数据隔离：组合必须属于当前用户
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId: user.userId },
      select: { id: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }

    const targetDate = parseDateParam(date);
    const items = await this.holdingDerivationService.derive(
      portfolioId,
      targetDate,
      includeClosed === 'true',
    );

    // 按标的过滤（可选）
    const filtered = securityId
      ? items.filter((h) => h.securityId === securityId)
      : items;

    // 汇总
    const totalMarketValue = filtered.reduce((sum, h) => sum + h.marketValue, 0);
    const totalCost = filtered.reduce((sum, h) => sum + h.costTotal, 0);
    const totalProfit = filtered.reduce((sum, h) => sum + h.pnl, 0);
    const aggregate: HoldingsAggregate = {
      totalMarketValue,
      totalCost,
      totalProfit,
      totalProfitRate: totalCost !== 0 ? totalProfit / totalCost : 0,
      securityCount: filtered.length,
    };

    return { items: filtered, aggregate };
  }
}
