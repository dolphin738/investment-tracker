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
 *   - types（可选）：标的类型多选白名单，逗号分隔 `types=STOCK,FUND`
 *     或重复参数 `types=STOCK&types=FUND`（Q-3 乙）
 * - 返回 { items: HoldingView[], aggregate: HoldingsAggregate }，
 *   ResponseInterceptor 会统一包装为 { code, data, message } 信封。
 * - 汇总口径唯一在后端（C-01）：aggregate 始终对**过滤后的子集**求和，
 *   因此 types/securityId 筛选后汇总自动随之变化，前端无需自行求和。
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
import { SecurityType } from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { HoldingDerivationService, HoldingView } from './holding-derivation.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { todayInAppTz, parseAppDate } from '../../common/utils/app-date.util';

/**
 * 标的类型白名单（唯一定义在 @investment-tracker/shared，前后端共用）
 *
 * 取值：STOCK / FUND / BOND / CASH / OTHER
 */
const SECURITY_TYPE_VALUES: readonly SecurityType[] = Object.values(SecurityType);

/**
 * 解析 `types` 查询参数为 SecurityType 白名单数组
 *
 * 支持两种传参形态（与 cashflow 的 types 多选保持一致）：
 * - 逗号分隔：`types=STOCK,FUND`
 * - 重复参数：`types=STOCK&types=FUND`（Express 解析为 string[]）
 *
 * 语义：
 * - 未传 / 空串 / 全是空项 → undefined（= 不过滤，返回全部类型）
 * - 含非白名单值 → 抛 400（与 class-validator `@IsEnum(..., { each: true })` 行为一致）
 * - 重复值自动去重，保持首次出现顺序
 *
 * @param raw 原始查询参数值
 * @returns SecurityType[] 白名单；undefined = 不过滤
 * @throws BadRequestException 存在非法类型值
 */
function parseSecurityTypes(
  raw?: string | string[],
): SecurityType[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const tokens = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);

  if (tokens.length === 0) {
    return undefined;
  }

  const result: SecurityType[] = [];
  for (const token of tokens) {
    if (!SECURITY_TYPE_VALUES.includes(token as SecurityType)) {
      throw new BadRequestException(
        `不支持的标的类型：${token}（可选值：${SECURITY_TYPE_VALUES.join(' / ')}）`,
      );
    }
    if (!result.includes(token as SecurityType)) {
      result.push(token as SecurityType);
    }
  }

  return result;
}

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
  @ApiQuery({ name: 'securityId', required: false, description: '标的 ID（支持逗号分隔多值）' })
  @ApiQuery({ name: 'includeClosed', required: false, description: '是否包含已清仓标的' })
  @ApiQuery({
    name: 'types',
    required: false,
    isArray: true,
    enum: SECURITY_TYPE_VALUES as SecurityType[],
    description:
      '标的类型多选筛选，逗号分隔 types=STOCK,FUND 或重复参数 types=STOCK&types=FUND；不传=全部',
  })
  async getHoldings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query('date') date?: string,
    @Query('securityId') securityId?: string,
    @Query('includeClosed') includeClosed?: string,
    @Query('types') types?: string | string[],
  ): Promise<{ items: HoldingView[]; aggregate: HoldingsAggregate }> {
    // 数据隔离：组合必须属于当前用户
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId: user.userId },
      select: { id: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }

    // 类型白名单校验放在推导之前，非法值快速失败（不做无谓的流水回放）
    const typeList = parseSecurityTypes(types);

    const targetDate = date ? parseAppDate(date) : todayInAppTz();
    const items = await this.holdingDerivationService.derive(
      portfolioId,
      targetDate,
      includeClosed === 'true',
    );

    // 按标的过滤（可选 · I-05：securityId 支持逗号分隔多值）
    // 例：?securityId=id1,id2 → 集合判断；单值向后兼容。
    const securityIds = securityId
      ? securityId.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
    const bySecurity =
      securityIds.length > 0
        ? items.filter((h) => securityIds.includes(h.securityId))
        : items;

    // 按标的类型白名单过滤（可选 · Q-3 乙）
    // derive() 返回的 HoldingView.securityType 是字符串，直接与白名单比对
    const filtered = typeList
      ? bySecurity.filter((h) =>
          typeList.includes(h.securityType as SecurityType),
        )
      : bySecurity;

    // 汇总（对过滤后的子集求和 → 筛选后汇总自动正确）
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
