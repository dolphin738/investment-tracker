/**
 * 资产快照控制器（方案B）
 *
 * 路由前缀：/api/portfolios/:portfolioId/snapshots
 *
 * 接口：
 * - POST   /api/portfolios/:portfolioId/snapshots              — 手工录入快照（source=MANUAL）
 * - GET    /api/portfolios/:portfolioId/snapshots              — 分页查询
 * - PATCH  /api/portfolios/:portfolioId/snapshots/:id          — 更新手工记录
 * - DELETE /api/portfolios/:portfolioId/snapshots/:id          — 删除记录（事件日回填 DERIVED）
 * - POST   /api/portfolios/:portfolioId/snapshots/:date/reset  — 重置为 DERIVED
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
import { SnapshotService } from './snapshot.service';
import { UpsertSnapshotDto, SnapshotQueryDto } from './dto/upsert-snapshot.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('资产快照')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/snapshots')
export class SnapshotController {
  constructor(private readonly snapshotService: SnapshotService) {}

  @Post()
  @ApiOperation({ summary: '手工录入资产快照（source=MANUAL）' })
  async upsertManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: UpsertSnapshotDto,
  ) {
    return this.snapshotService.upsertManual(user.userId, portfolioId, dto);
  }

  @Get()
  @ApiOperation({ summary: '查询快照列表（分页 + 日期范围）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: SnapshotQueryDto,
  ) {
    return this.snapshotService.findAll(user.userId, portfolioId, query);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新手工快照记录' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
    @Body() dto: UpsertSnapshotDto,
  ) {
    return this.snapshotService.update(user.userId, portfolioId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除快照记录（事件日自动回填 DERIVED）' })
  async deleteRecord(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.snapshotService.deleteRecord(user.userId, portfolioId, id);
  }

  @Post(':date/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '重置指定日期快照为 DERIVED' })
  async resetToDerived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('date') date: string,
  ) {
    return this.snapshotService.resetToDerived(user.userId, portfolioId, date);
  }
}
