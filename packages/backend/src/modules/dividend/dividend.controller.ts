/**
 * 分红记录控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId/dividends
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/dividends       — 分红列表
 * - POST   /api/portfolios/:portfolioId/dividends       — 新增分红
 * - DELETE /api/portfolios/:portfolioId/dividends/:id   — 删除分红
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
import { DividendService } from './dividend.service';
import { CreateDividendRecordDto } from './dto/create-dividend-record.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('分红记录')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/dividends')
export class DividendController {
  constructor(private readonly dividendService: DividendService) {}

  @Get()
  @ApiOperation({ summary: '分红记录列表（可按标的过滤）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query('securityId') securityId?: string,
  ) {
    return this.dividendService.findAll(portfolioId, user.userId, securityId);
  }

  @Post()
  @ApiOperation({ summary: '新增分红记录' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateDividendRecordDto,
  ) {
    return this.dividendService.create(portfolioId, user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除分红记录' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.dividendService.remove(portfolioId, id, user.userId);
  }
}
