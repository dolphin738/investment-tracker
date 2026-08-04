/**
 * 认证控制器
 *
 * 路由前缀：/api/auth（全局前缀 /api + 控制器前缀 auth）
 *
 * 接口：
 * - POST  /api/auth/register — 用户注册（公开）
 * - POST  /api/auth/login — 用户登录（公开）
 * - GET   /api/auth/profile — 获取当前用户信息（需认证）
 * - PATCH /api/auth/password — 修改密码（需认证）
 * - PATCH /api/auth/email — 修改邮箱（需认证）
 * - PATCH /api/auth/profile — 修改个人资料（需认证）
 * - DELETE /api/auth/account — 注销账户（需认证，软删除保留 30 天可恢复）
 *
 * 注意：全局 JWT 守卫（APP_GUARD）默认保护所有路由，
 * 未标注 @Public() 的接口即为需认证接口，无需再写 @UseGuards。
 * 响应信封由全局 TransformInterceptor 统一包装，此处直接返回裸对象。
 */

import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateEmailDto } from './dto/update-email.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: '用户注册' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.email, dto.password, dto.name);
  }

  @Public()
  @Post('login')
  @ApiOperation({ summary: '用户登录' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Get('profile')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: '获取当前用户信息' })
  async getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.userId);
  }

  @Patch('password')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: '修改密码' })
  async updatePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePasswordDto,
  ) {
    return this.authService.updatePassword(user.userId, dto);
  }

  // TODO(P2): 限流可在此挂 @UseGuards(ThrottlerGuard)
  @Patch('email')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: '修改邮箱' })
  async updateEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateEmailDto,
  ) {
    return this.authService.updateEmail(user.userId, dto);
  }

  // TODO(P2): 限流可在此挂 @UseGuards(ThrottlerGuard)
  @Patch('profile')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: '修改个人资料' })
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(user.userId, dto);
  }

  @Delete('account')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: '注销账户（软删除，保留 30 天可恢复）',
    description:
      '软删除当前用户（deletedAt=now，SET-P1-06）。用户及其全部组合数据保留 30 天可恢复；' +
      '软删除期间该用户不能登录，email 仍占用唯一索引（30 天后清理释放）。',
  })
  async deleteAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.deleteAccount(user.userId);
  }
}
