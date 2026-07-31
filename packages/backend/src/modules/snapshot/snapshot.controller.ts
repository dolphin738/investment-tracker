/**
 * 资产快照控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId/snapshots
 *
 * 接口：
 * - PUT    /api/portfolios/:portfolioId/snapshots          — 录入/覆盖快照（upsert）
 * - GET    /api/portfolios/:portfolioId/snapshots          — 获取快照列表（分页 + 日期范围）
 * - DELETE /api/portfolios/:portfolioId/snapshots/:id      — 删除快照
 *
 * 使用 PUT 实现 upsert 语义：每日唯一快照，重复录入则覆盖。
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SnapshotService } from './snapshot.service';
import { UpsertSnapshotDto } from './dto/upsert-snapshot.dto';
import { SnapshotQueryDto } from './dto/snapshot-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('资产快照')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/snapshots')
export class SnapshotController {
  constructor(private readonly snapshotService: SnapshotService) {}

  @Put()
  @ApiOperation({ summary: '录入/覆盖资产快照（upsert，每日唯一）' })
  async upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: UpsertSnapshotDto,
  ) {
    return this.snapshotService.upsert(user.userId, portfolioId, dto);
  }

  @Get()
  @ApiOperation({ summary: '获取快照列表（分页 + 日期范围）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: SnapshotQueryDto,
  ) {
    return this.snapshotService.findAll(user.userId, portfolioId, query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除快照' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.snapshotService.remove(user.userId, portfolioId, id);
  }
}
