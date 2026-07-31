/**
 * 交易管理控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId/transactions
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/transactions          — 查询交易列表
 * - POST   /api/portfolios/:portfolioId/transactions          — 录入交易
 * - GET    /api/portfolios/:portfolioId/transactions/:id      — 查询单笔交易
 * - PATCH  /api/portfolios/:portfolioId/transactions/:id      — 编辑交易
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
import { PaginationDto } from '../../common/dto/pagination.dto';
import { DateRangeDto } from '../../common/dto/date-range.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('交易管理')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get()
  @ApiOperation({ summary: '获取交易列表（分页 + 日期范围）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: PaginationDto & DateRangeDto,
  ) {
    return this.transactionService.findAll(user.userId, portfolioId, query);
  }

  @Post()
  @ApiOperation({ summary: '录入交易' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.transactionService.create(user.userId, portfolioId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '查询单笔交易' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.transactionService.findOne(user.userId, portfolioId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '编辑交易' })
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
