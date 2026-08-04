/**
 * 头像上传服务单元测试
 *
 * 全部依赖（StorageService / PrismaService）均为 mock，不触碰真实磁盘与数据库。
 *
 * 覆盖点：
 * 1. 魔数嗅探正确推导 jpg / png / webp，非图片内容返回 null
 * 2. 非法 mimetype → 抛 1006
 * 3. 超过 2MB → 抛 1006
 * 4. 成功路径：storage.save 被调用、prisma.user.update 写入 avatar、返回含 user
 * 5. LocalDiskStorage.canRemove 三重校验：越权 / 穿越 / 外链路径一律 false
 */

import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalDiskStorage } from './storage/local-disk.storage';
import type { StorageService, StoredFile } from './storage/storage.service';
import { UploadService, sniffImageExt } from './upload.service';
import type { UploadedFileLike } from './upload.types';
import { AVATAR_URL_PREFIX, FILE_INVALID_CODE, MAX_SIZE } from './upload.constants';
import type { PrismaService } from '../../prisma/prisma.service';

// ============================================================
// 辅助构造
// ============================================================

/** 构造带指定文件头的 buffer，尾部用 0 填充到 minLength */
function bufferWithHeader(header: number[], totalLength = 32): Buffer {
  const buf = Buffer.alloc(Math.max(totalLength, header.length), 0);
  Buffer.from(header).copy(buf, 0);
  return buf;
}

/** 合法 PNG 文件头 */
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** 合法 JPEG 文件头 */
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];

/** 合法 WebP 文件头：'RIFF' + 4 字节长度 + 'WEBP' */
function webpBuffer(): Buffer {
  const buf = Buffer.alloc(32, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  return buf;
}

/** 构造上传文件对象 */
function makeFile(overrides: Partial<UploadedFileLike> = {}): UploadedFileLike {
  const buffer = overrides.buffer ?? bufferWithHeader(PNG_HEADER);
  return {
    fieldname: 'file',
    originalname: 'avatar.png',
    mimetype: 'image/png',
    buffer,
    size: buffer.length,
    ...overrides,
  };
}

/** mock 出来的 StorageService */
interface MockStorage extends StorageService {
  save: jest.Mock<Promise<StoredFile>, [Buffer, string]>;
  remove: jest.Mock<Promise<void>, [string]>;
  canRemove: jest.Mock<boolean, [string]>;
  resolvePath: jest.Mock<string, [string]>;
}

function createMockStorage(): MockStorage {
  return {
    save: jest.fn(async (_buffer: Buffer, ext: string) => ({
      url: `${AVATAR_URL_PREFIX}/11111111-2222-3333-4444-555555555555.${ext}`,
      path: `/tmp/uploads/avatar/11111111-2222-3333-4444-555555555555.${ext}`,
    })),
    remove: jest.fn(async () => undefined),
    canRemove: jest.fn(() => false),
    resolvePath: jest.fn((url: string) => `/tmp/uploads/avatar/${url.split('/').pop()}`),
  } as unknown as MockStorage;
}

/** mock 出来的 PrismaService（只暴露用到的 user 委托） */
function createMockPrisma() {
  return {
    user: {
      findUnique: jest.fn(async () => ({ avatar: null })),
      update: jest.fn(async ({ data }: { data: { avatar: string } }) => ({
        id: 'user-1',
        email: 'kou@example.com',
        passwordHash: 'hashed',
        name: '寇豆码',
        avatar: data.avatar,
        phone: '13800138000',
        bio: '长期主义',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    },
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

function createService(): {
  service: UploadService;
  storage: MockStorage;
  prisma: MockPrisma;
} {
  const storage = createMockStorage();
  const prisma = createMockPrisma();
  const service = new UploadService(storage, prisma as unknown as PrismaService);
  return { service, storage, prisma };
}

// ============================================================
// 1. 魔数嗅探
// ============================================================

describe('sniffImageExt — 魔数嗅探', () => {
  it('识别 JPEG 文件头 FF D8 FF', () => {
    expect(sniffImageExt(bufferWithHeader(JPEG_HEADER))).toBe('jpg');
  });

  it('识别 PNG 文件头 89 50 4E 47 0D 0A 1A 0A', () => {
    expect(sniffImageExt(bufferWithHeader(PNG_HEADER))).toBe('png');
  });

  it('识别 WebP 文件头 RIFF....WEBP', () => {
    expect(sniffImageExt(webpBuffer())).toBe('webp');
  });

  it('RIFF 但不是 WEBP（如 wav）返回 null', () => {
    const buf = Buffer.alloc(32, 0);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WAVE', 8, 'ascii');
    expect(sniffImageExt(buf)).toBeNull();
  });

  it('非图片内容（如 PDF / 纯文本）返回 null', () => {
    expect(sniffImageExt(Buffer.from('%PDF-1.7 fake pdf content'))).toBeNull();
  });

  it('长度不足 12 字节返回 null', () => {
    expect(sniffImageExt(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

// ============================================================
// 2/3. 校验失败路径
// ============================================================

describe('UploadService.uploadAvatar — 校验失败', () => {
  it('文件缺失 → 1006', async () => {
    const { service, storage, prisma } = createService();
    await expect(service.uploadAvatar('user-1', undefined)).rejects.toMatchObject({
      response: { code: FILE_INVALID_CODE },
    });
    expect(storage.save).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('非法 mimetype（image/gif）→ 1006，且不落盘不写库', async () => {
    const { service, storage, prisma } = createService();
    const file = makeFile({ mimetype: 'image/gif' });

    await expect(service.uploadAvatar('user-1', file)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.uploadAvatar('user-1', file)).rejects.toMatchObject({
      response: { code: FILE_INVALID_CODE, message: '仅支持 JPG / PNG / WebP 格式的图片' },
    });
    expect(storage.save).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('mimetype 合法但内容不是图片（伪装）→ 1006', async () => {
    const { service, storage } = createService();
    const file = makeFile({
      mimetype: 'image/png',
      buffer: Buffer.from('%PDF-1.7 this is definitely not a png'),
    });

    await expect(service.uploadAvatar('user-1', file)).rejects.toMatchObject({
      response: { code: FILE_INVALID_CODE },
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('超过 2MB → 1006，且不落盘不写库', async () => {
    const { service, storage, prisma } = createService();
    const file = makeFile({ size: MAX_SIZE + 1 });

    await expect(service.uploadAvatar('user-1', file)).rejects.toMatchObject({
      response: { code: FILE_INVALID_CODE, message: '图片大小不能超过 2MB' },
    });
    expect(storage.save).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('恰好等于 2MB → 放行', async () => {
    const { service, storage } = createService();
    const file = makeFile({ size: MAX_SIZE });

    await expect(service.uploadAvatar('user-1', file)).resolves.toBeDefined();
    expect(storage.save).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 4. 成功路径
// ============================================================

describe('UploadService.uploadAvatar — 成功路径', () => {
  it('落盘 + 写库 + 返回用户公开信息', async () => {
    const { service, storage, prisma } = createService();
    const file = makeFile();

    const result = await service.uploadAvatar('user-1', file);

    // storage.save 收到的是 buffer 与嗅探出的扩展名
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.save).toHaveBeenCalledWith(file.buffer, 'png');

    // prisma 写入的是 storage 返回的 URL
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { avatar: result.url },
    });

    // 返回值结构
    expect(result.url).toMatch(/^\/api\/uploads\/avatar\/[0-9a-f-]{36}\.png$/);
    expect(result.user).toEqual({
      id: 'user-1',
      email: 'kou@example.com',
      name: '寇豆码',
      avatar: result.url,
      phone: '13800138000',
      bio: '长期主义',
      // ACC-P0-02：注册时间由 toUserPublic 统一投影
      createdAt: expect.any(String),
    });
    // 公开投影绝不能泄漏密码哈希
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  it('扩展名以魔数为准，忽略 originalname 伪装', async () => {
    const { service, storage } = createService();
    const file = makeFile({
      originalname: '../../etc/passwd.sh',
      mimetype: 'image/jpeg',
      buffer: bufferWithHeader(JPEG_HEADER),
    });

    await service.uploadAvatar('user-1', file);
    expect(storage.save).toHaveBeenCalledWith(file.buffer, 'jpg');
  });

  it('旧头像可删除时，fire-and-forget 调用 storage.remove', async () => {
    const { service, storage, prisma } = createService();
    const oldUrl = `${AVATAR_URL_PREFIX}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`;
    prisma.user.findUnique.mockResolvedValueOnce({ avatar: oldUrl } as never);
    storage.canRemove.mockReturnValueOnce(true);

    await service.uploadAvatar('user-1', makeFile());

    expect(storage.canRemove).toHaveBeenCalledWith(oldUrl);
    expect(storage.resolvePath).toHaveBeenCalledWith(oldUrl);
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it('旧头像是外链（canRemove=false）时不删除任何文件', async () => {
    const { service, storage, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce({
      avatar: 'https://cdn.example.com/a.png',
    } as never);
    storage.canRemove.mockReturnValueOnce(false);

    await service.uploadAvatar('user-1', makeFile());

    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('删除旧文件失败不影响上传结果（只告警）', async () => {
    const { service, storage, prisma } = createService();
    const oldUrl = `${AVATAR_URL_PREFIX}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`;
    prisma.user.findUnique.mockResolvedValueOnce({ avatar: oldUrl } as never);
    storage.canRemove.mockReturnValueOnce(true);
    storage.remove.mockRejectedValueOnce(new Error('EACCES'));

    await expect(service.uploadAvatar('user-1', makeFile())).resolves.toBeDefined();
  });
});

// ============================================================
// 5. LocalDiskStorage.canRemove 三重校验
// ============================================================

describe('LocalDiskStorage.canRemove — 越权删除防护', () => {
  /** 用固定的 UPLOAD_DIR 构造驱动，避免依赖真实环境变量 */
  function createStorage(): LocalDiskStorage {
    const config = {
      get: (key: string): string | undefined =>
        key === 'UPLOAD_DIR' ? '/tmp/it-uploads' : undefined,
    } as unknown as ConfigService;
    return new LocalDiskStorage(config);
  }

  const validUrl = `${AVATAR_URL_PREFIX}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`;

  it('本驱动生成的合法 URL → true', () => {
    expect(createStorage().canRemove(validUrl)).toBe(true);
  });

  it.each([
    ['空字符串', ''],
    ['外链地址', 'https://cdn.example.com/avatar.png'],
    ['前缀不符（缺 /api）', '/uploads/avatar/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png'],
    ['其它业务目录', '/api/uploads/report/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png'],
    ['路径穿越 ../../etc/passwd', `${AVATAR_URL_PREFIX}/../../etc/passwd`],
    ['编码穿越', `${AVATAR_URL_PREFIX}/..%2F..%2Fetc%2Fpasswd`],
    ['嵌套子目录', `${AVATAR_URL_PREFIX}/sub/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`],
    ['非法扩展名', `${AVATAR_URL_PREFIX}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.sh`],
    ['非 uuid 文件名', `${AVATAR_URL_PREFIX}/evil.png`],
    ['带查询串', `${AVATAR_URL_PREFIX}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png?x=1`],
  ])('%s → false', (_label, url) => {
    expect(createStorage().canRemove(url)).toBe(false);
  });

  it('resolvePath 还原出的路径始终落在头像目录内', () => {
    const storage = createStorage();
    const resolved = storage.resolvePath(validUrl);
    // 用 path.resolve 归一后再比较：Windows 下 path.join('/tmp/x') 不带盘符，
    // 而 path.resolve 会补上当前盘符，直接 startsWith 会误判。
    expect(resolved.startsWith(path.resolve(storage.getBaseDir()))).toBe(true);
  });
});
