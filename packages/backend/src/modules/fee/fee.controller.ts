/**
 * 费用记录控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId/fees
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/fees       — 费用列表
 * - POST   /api/portfolios/:portfolioId/fees       — 新增费用
 * - DELETE /api/portfolios/:portfolioId/fees/:id   — 删除费用
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FeeService } from './fee.service';
import { CreateFeeRecordDto } from './dto/create-fee-record.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('费用记录')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/fees')
export class FeeController {
  constructor(private readonly feeService: FeeService) {}

  @Get()
  @ApiOperation({ summary: '费用记录列表（可按标的过滤）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query('securityId') securityId?: string,
  ) {
    return this.feeService.findAll(portfolioId, user.userId, securityId);
  }

  @Post()
  @ApiOperation({ summary: '新增费用记录' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateFeeRecordDto,
  ) {
    return this.feeService.create(portfolioId, user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除费用记录' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.feeService.remove(portfolioId, id, user.userId);
  }
}
