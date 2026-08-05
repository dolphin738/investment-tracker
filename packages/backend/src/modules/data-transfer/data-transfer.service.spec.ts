/**
 * DataTransferService — CSV/Excel 导入导出验收（T05）
 *
 * 验证点：
 * - 导出：CSV 含 UTF-8 BOM + 英文表头；Decimal 以 string 原样输出。
 * - 预览：**绝不写库**（$transaction 不被调用）；返回 sample / errors / token。
 * - 提交：单 Prisma 事务批量写入；
 *   🔴 **全流程仅 1 次 `recalculateNavRange`（N 行也只调 1 次）——关键验收**。
 * - 冲突：assetSnapshots 走 upsert 且 source 强制 MANUAL；securityTrades 标的不存在 → SECURITY_NOT_FOUND。
 * - token 不匹配 / 过期 → BadRequest。
 */

import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { ExportType, ImportType } from '@investment-tracker/shared';
import { DataTransferService, type MulterFileLike } from './data-transfer.service';
import { toXlsx } from './csv/xlsx-serializer';
import { EXPORT_SCHEMAS } from './csv/export-schemas';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RecalculationService } from '../recalculation/recalculation.service';
import type { ExportQueryDto } from './dto/export-query.dto';

const USER_ID = 'user-1';
const PORTFOLIO_ID = 'pf-1';

/** multer 文件夹具 */
function makeFile(name: string, text: string): MulterFileLike {
  return {
    originalname: name,
    mimetype: 'text/csv',
    size: Buffer.byteLength(text),
    buffer: Buffer.from(text, 'utf8'),
    fieldname: 'file',
    encoding: '7bit',
  } as MulterFileLike;
}

/** 事务 mock：与 service 内部 tx.xxx 调用对齐 */
function makeTxMock() {
  return {
    securityTrade: { create: jest.fn().mockResolvedValue({}) },
    cashFlow: { create: jest.fn().mockResolvedValue({}) },
    assetSnapshot: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
}

function createService(options: {
  securities?: Array<{ id: string; code: string }>;
  cashFlows?: unknown[];
}) {
  const { securities = [], cashFlows = [] } = options;
  const txMock = makeTxMock();

  const prisma = {
    portfolio: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: PORTFOLIO_ID, name: '测试组合' }),
    },
    security: { findMany: jest.fn().mockResolvedValue(securities) },
    cashFlow: { findMany: jest.fn().mockResolvedValue(cashFlows) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(txMock),
    ),
  };

  const recalculationService = {
    recalculateNavRange: jest.fn().mockResolvedValue(5),
  } as unknown as RecalculationService;

  const service = new DataTransferService(
    prisma as unknown as PrismaService,
    recalculationService,
  );

  return { service, prisma, txMock, recalculationService };
}

const EXPORT_QUERY = { type: ExportType.CASH_FLOWS } as ExportQueryDto;

describe('DataTransferService.export — CSV 导出', () => {
  it('CSV 以 BOM 开头、含英文表头，Decimal 字符串原样输出', async () => {
    const { service } = createService({
      cashFlows: [
        {
          id: 'cf-1',
          portfolioId: PORTFOLIO_ID,
          date: new Date('2026-01-01T00:00:00.000Z'),
          type: 'BUY',
          amount: new Prisma.Decimal('10000.00'),
          note: '本金',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });

    const result = await service.export(USER_ID, PORTFOLIO_ID, EXPORT_QUERY);

    expect(result.filename).toMatch(/\.csv$/);
    expect(result.contentType).toContain('text/csv');
    const content = result.content as string;
    expect(content.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(content).toContain('date,type,amount,note');
    expect(content).toContain('2026-01-01,BUY,10000.00,本金');
  });
});

describe('DataTransferService.preview — 预览不写库', () => {
  it('返回 sample / errors / token，且不触发 $transaction', async () => {
    const { service, prisma } = createService({});
    const csv = 'date,type,amount,note\n2026-01-01,BUY,10000.00,本金\n';
    const file = makeFile('cashflows.csv', csv);

    const result = await service.preview(
      USER_ID,
      PORTFOLIO_ID,
      ImportType.CASH_FLOWS,
      file,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled(); // 预览绝不写库
    expect(result.totalRows).toBe(1);
    expect(result.validRows).toBe(1);
    expect(result.sample).toHaveLength(1);
    expect(result.sample[0]).toMatchObject({
      date: '2026-01-01',
      type: 'BUY',
      amount: '10000.00',
    });
    expect(result.errors).toEqual([]);
    expect(result.minDate).toBe('2026-01-01');
    expect(result.token).toBeTruthy();
  });

  it('securityTrades：标的不存在 → SECURITY_NOT_FOUND（不阻断其它错误）', async () => {
    const { service } = createService({
      securities: [{ id: 's-1', code: 'SEC0001' }],
    });
    const csv =
      'securityCode,date,side,quantity,price,fee,note\n' +
      'UNKNOWN,2026-01-01,BUY_SEC,100,10.50,5.00,\n';
    const file = makeFile('trades.csv', csv);

    const result = await service.preview(
      USER_ID,
      PORTFOLIO_ID,
      ImportType.SECURITY_TRADES,
      file,
    );

    expect(result.validRows).toBe(0);
    expect(result.errors.some((e) => e.code === 'SECURITY_NOT_FOUND')).toBe(
      true,
    );
  });
});

describe('DataTransferService.commit — 🔴 单次重算铁律', () => {
  it('【关键】3 行 cashFlows 提交后 recalculateNavRange 只调 1 次', async () => {
    const { service, txMock, recalculationService } = createService({});
    const csv =
      'date,type,amount,note\n' +
      '2026-01-01,BUY,10000.00,\n' +
      '2026-01-02,BUY,5000.00,\n' +
      '2026-01-03,SELL,2000.00,\n';
    const file = makeFile('cashflows.csv', csv);

    const preview = await service.preview(
      USER_ID,
      PORTFOLIO_ID,
      ImportType.CASH_FLOWS,
      file,
    );
    expect(preview.validRows).toBe(3);

    const result = await service.commit(
      USER_ID,
      PORTFOLIO_ID,
      ImportType.CASH_FLOWS,
      preview.token,
    );

    expect(txMock.cashFlow.create).toHaveBeenCalledTimes(3);
    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.failed).toEqual([]);
    // 🔴 关键：无论多少行，重算只调 1 次
    expect(recalculationService.recalculateNavRange).toHaveBeenCalledTimes(1);
    expect(recalculationService.recalculateNavRange).toHaveBeenCalledWith(
      PORTFOLIO_ID,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(result.recalculated).toMatchObject({
      fromDate: '2026-01-01',
      recalculatedDays: 5,
    });
  });

  it('assetSnapshots：按 (portfolioId, date) upsert，source 强制 MANUAL', async () => {
    const { service, txMock, recalculationService } = createService({});
    const csv =
      'date,totalAsset,marketValue,cashBalance,note\n' +
      '2026-01-01,100000.00,80000.00,20000.00,月末估值\n';
    const file = makeFile('snapshots.csv', csv);

    const preview = await service.preview(
      USER_ID,
      PORTFOLIO_ID,
      ImportType.ASSET_SNAPSHOTS,
      file,
    );
    expect(preview.validRows).toBe(1);

    const result = await service.commit(
      USER_ID,
      PORTFOLIO_ID,
      ImportType.ASSET_SNAPSHOTS,
      preview.token,
    );

    expect(txMock.assetSnapshot.upsert).toHaveBeenCalledTimes(1);
    const upsertPayload = txMock.assetSnapshot.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
    };
    expect(upsertPayload.create.source).toBe('MANUAL');
    expect(upsertPayload.create.valuationFlag).toBe('MANUAL_INPUT');
    expect(result.inserted).toBe(1);
    expect(recalculationService.recalculateNavRange).toHaveBeenCalledTimes(1);
  });

  it('token 不匹配 → BadRequest（不写库、不重算）', async () => {
    const { service, recalculationService } = createService({});
    await expect(
      service.commit(USER_ID, PORTFOLIO_ID, ImportType.CASH_FLOWS, 'bad-token'),
    ).rejects.toThrow('导入预览已过期');
    expect(recalculationService.recalculateNavRange).not.toHaveBeenCalled();
  });

  it('XLSX 冒烟：导出 toXlsx → 导入 preview → commit 全链路走通', async () => {
    const { service, txMock, recalculationService } = createService({});
    // 用导出端 toXlsx 生成现金余额 XLSX（模拟「导出 → 修改 → 导入」闭环）
    const columns = EXPORT_SCHEMAS[ExportType.CASH_FLOWS];
    const buf = toXlsx(
      [
        {
          id: 'cf-1',
          portfolioId: PORTFOLIO_ID,
          date: '2026-01-01',
          type: 'BUY',
          amount: '10000.00',
          note: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      columns,
    );
    const file = {
      originalname: 'cashflows.xlsx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: buf.length,
      buffer: buf,
      fieldname: 'file',
      encoding: '7bit',
    } as MulterFileLike;

    const preview = await service.preview(
      USER_ID,
      PORTFOLIO_ID,
      ImportType.CASH_FLOWS,
      file,
    );
    expect(preview.totalRows).toBe(1);
    expect(preview.validRows).toBe(1);
    expect(preview.sample[0]).toMatchObject({
      date: '2026-01-01',
      type: 'BUY',
      amount: '10000.00',
    });

    const result = await service.commit(
      USER_ID,
      PORTFOLIO_ID,
      ImportType.CASH_FLOWS,
      preview.token,
    );
    expect(txMock.cashFlow.create).toHaveBeenCalledTimes(1);
    expect(result.inserted).toBe(1);
    expect(recalculationService.recalculateNavRange).toHaveBeenCalledTimes(1);
  });
});
