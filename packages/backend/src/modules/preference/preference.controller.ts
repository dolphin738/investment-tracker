/**
 * 用户偏好控制器
 *
 * 路由前缀：/api/users/preferences
 *
 * 接口：
 * - GET   /api/users/preferences  — 获取偏好（首次自动创建默认值）
 * - PATCH /api/users/preferences  — 更新偏好
 */

import {
  Body,
  Controller,
  Get,
  Patch,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PreferenceService } from './preference.service';
import { UpdatePreferenceDto } from './dto/update-preference.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('用户偏好')
@ApiBearerAuth('JWT-auth')
@Controller('users/preferences')
export class PreferenceController {
  constructor(private readonly preferenceService: PreferenceService) {}

  @Get()
  @ApiOperation({ summary: '获取用户偏好（首次自动创建默认值）' })
  async get(@CurrentUser() user: AuthenticatedUser) {
    return this.preferenceService.get(user.userId);
  }

  @Patch()
  @ApiOperation({ summary: '更新用户偏好' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferenceDto,
  ) {
    return this.preferenceService.update(user.userId, dto);
  }
}
