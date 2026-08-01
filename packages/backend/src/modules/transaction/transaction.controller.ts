/**
 * 交易管理控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId/transactions
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/transactions          — 查询交易列表（🆕 支持 type/securityId 筛选）
 * - POST   /api/portfolios/:portfolioId/transactions          — 录入交易（🆕 支持 securityId/quantity/price/fee）
 * - GET    /api/portfolios/:portfolioId/transactions/aggregated — 交易多维聚合查询（🆕 T03）
 * - GET    /api/portfolios/:portfolioId/transactions/:id      — 查询单笔交易（🆕 返回 securityName）
 * - PATCH  /api/portfolios/:portfolioId/transactions/:id      — 编辑交易（🆕 支持新字段）
 * - DELETE /api/portfolios/:portfolioId/transactions/:id      — 删除交易
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TransactionService } from './transaction.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { TransactionQueryDto } from './dto/transaction-query.dto';
import { TransactionAggregatedQueryDto } from './dto/transaction-aggregated-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('交易管理')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get()
  @ApiOperation({ summary: '获取交易列表（分页 + 日期范围 + 类型 + 标的筛选）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: TransactionQueryDto,
  ) {
    return this.transactionService.findAll(user.userId, portfolioId, query);
  }

  @Post()
  @ApiOperation({ summary: '录入交易（支持标的/数量/单价/费用）' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.transactionService.create(user.userId, portfolioId, dto);
  }

  @Get('aggregated')
  @ApiOperation({ summary: '交易多维聚合查询（按年/月/周/日聚合买入/卖出/净现金流/笔数）' })
  async findAggregated(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: TransactionAggregatedQueryDto,
  ) {
    return this.transactionService.findAggregated(user.userId, portfolioId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: '查询单笔交易（含标的名称）' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.transactionService.findOne(user.userId, portfolioId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '编辑交易（支持新字段）' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTransactionDto,
  ) {
    return this.transactionService.update(user.userId, portfolioId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除交易' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.transactionService.remove(user.userId, portfolioId, id);
  }
}
