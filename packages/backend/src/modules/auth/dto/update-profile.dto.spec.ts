/**
 * UpdateProfileDto 校验契约测试（P0-5 回归）
 *
 * P0-5 把 avatar 的校验从 @IsUrl({require_protocol:true}) 放宽为自定义正则，
 * 目的是让 AC-11 上传返回的站内相对路径 `/api/uploads/avatar/<uuid>.png`
 * 能通过 PATCH /api/auth/profile。放宽的同时不能把 XSS / 开放重定向放进来，
 * 因此这里用真实的 class-validator 跑一遍白名单与黑名单。
 *
 * 覆盖点：
 * 1. 三态语义：undefined 不改 / null 与 '' 清空 / 有值更新
 * 2. 放行：站内相对路径、http(s) 外链
 * 3. 拒绝：javascript: 伪协议、data: URI、//evil.com 协议相对 URL、超长
 * 4. toUserPublic 返回结构含 avatar / phone / bio（与 PATCH 返回结构一致）
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';
import { toUserPublic } from '../user-public.mapper';
import { AVATAR_URL_PREFIX } from '../../upload/upload.constants';

/** 跑一次校验，返回 avatar 字段上的错误约束（无错误则为 undefined） */
function validateAvatar(avatar: unknown): Record<string, string> | undefined {
  const dto = plainToInstance(UpdateProfileDto, { avatar });
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.find((e) => e.property === 'avatar')?.constraints;
}

describe('UpdateProfileDto — avatar 校验（P0-5）', () => {
  describe('应放行的合法值', () => {
    const valid: Array<[string, unknown]> = [
      ['字段缺省（不修改）', undefined],
      ['null（清空）', null],
      ['空串（清空 → 后端转 NULL）', ''],
      ['上传接口返回的站内路径', `${AVATAR_URL_PREFIX}/2f1c9b0e-7a3d-4f6b-9c2e-5d8a1b0c3e4f.png`],
      ['站内 jpg 路径', '/api/uploads/avatar/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg'],
      ['站内 webp 路径', '/api/uploads/avatar/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp'],
      ['根路径', '/'],
      ['https 外链', 'https://cdn.example.com/avatar/foo.png'],
      ['http 外链', 'http://img.example.com/a.jpg'],
      ['带查询串的外链', 'https://cdn.example.com/a.png?w=200&h=200'],
    ];

    it.each(valid)('%s 应通过校验', (_name, value) => {
      expect(validateAvatar(value)).toBeUndefined();
    });

    it('上传返回的真实前缀必须被 DTO 接受（AC-11 与 P0-5 的契约衔接点）', () => {
      // 若 AVATAR_URL_PREFIX 改动导致与正则不匹配，这条会第一时间失败
      expect(AVATAR_URL_PREFIX).toBe('/api/uploads/avatar');
      expect(validateAvatar(`${AVATAR_URL_PREFIX}/x.png`)).toBeUndefined();
    });
  });

  describe('应拒绝的危险值', () => {
    const invalid: Array<[string, string]> = [
      ['javascript: 伪协议（XSS）', 'javascript:alert(1)'],
      ['大小写混淆的伪协议', 'JaVaScRiPt:alert(1)'],
      ['data: URI（XSS）', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
      ['协议相对 URL（开放重定向）', '//evil.com/x.png'],
      ['协议相对 URL 变体', '//evil.com'],
      ['vbscript 伪协议', 'vbscript:msgbox(1)'],
      ['file 协议', 'file:///etc/passwd'],
      ['无协议裸域名', 'evil.com/x.png'],
      ['相对路径不以 / 开头', 'uploads/avatar/x.png'],
    ];

    it.each(invalid)('%s 应被拒绝', (_name, value) => {
      const constraints = validateAvatar(value);
      expect(constraints).toBeDefined();
      expect(Object.keys(constraints ?? {})).toContain('matches');
    });

    it('超过 512 字符应被 @MaxLength 拒绝', () => {
      const tooLong = `/api/uploads/avatar/${'a'.repeat(520)}.png`;
      const constraints = validateAvatar(tooLong);
      expect(constraints).toBeDefined();
      expect(Object.keys(constraints ?? {})).toContain('maxLength');
    });

    it('非字符串类型应被 @IsString 拒绝', () => {
      const constraints = validateAvatar(12345);
      expect(constraints).toBeDefined();
      expect(Object.keys(constraints ?? {})).toContain('isString');
    });
  });

  describe('清空语义（空串不得被格式校验拦下）', () => {
    it('空串应通过，从而允许「移除头像」', () => {
      // 这是 @ValidateIf 存在的理由：@IsOptional 不跳过 ''，会让移除头像返回 400
      expect(validateAvatar('')).toBeUndefined();
    });

    it('null 应通过', () => {
      expect(validateAvatar(null)).toBeUndefined();
    });
  });
});

describe('toUserPublic 返回结构（PATCH /auth/profile 与上传接口共用）', () => {
  it('应包含 avatar / phone / bio 且不泄露密码等敏感字段', () => {
    const now = new Date();
    const user = {
      id: 'user-1',
      email: 'a@b.com',
      password: 'hashed-secret',
      name: '张三',
      avatar: '/api/uploads/avatar/2f1c9b0e-7a3d-4f6b-9c2e-5d8a1b0c3e4f.png',
      phone: '13800138000',
      bio: '长期主义者',
      createdAt: now,
      updatedAt: now,
    };

    const result = toUserPublic(user as unknown as Parameters<typeof toUserPublic>[0]);

    expect(result).toEqual({
      id: 'user-1',
      email: 'a@b.com',
      name: '张三',
      avatar: '/api/uploads/avatar/2f1c9b0e-7a3d-4f6b-9c2e-5d8a1b0c3e4f.png',
      phone: '13800138000',
      bio: '长期主义者',
    });
    expect(result).not.toHaveProperty('password');
  });

  it('avatar / phone / bio 为 null 时应原样返回 null（而非丢字段）', () => {
    const user = {
      id: 'user-2',
      email: 'c@d.com',
      password: 'x',
      name: null,
      avatar: null,
      phone: null,
      bio: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = toUserPublic(user as unknown as Parameters<typeof toUserPublic>[0]);

    expect(Object.keys(result).sort()).toEqual(['avatar', 'bio', 'email', 'id', 'name', 'phone']);
    expect(result.avatar).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.bio).toBeNull();
  });
});
