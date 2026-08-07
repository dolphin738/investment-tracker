/**
 * data-transfer.service.ts — CSV / Excel 导入导出编排（T05 · AL-042/079/080 + Excel 扩展）
 *
 * 导出：
 * - 7 类（ExportType）→ CSV（UTF-8 + BOM）或 XLSX，Decimal 一律 string 原样输出。
 *
 * 导入（两阶段）：
 * - preview：解析（CSV→papaparse / XLSX→xlsx）→ 行级校验 → 返回预览结果 + token，**绝不写库**。
 * - commit：单 Prisma 事务写入 → **事务外只调一次** `recalculateNavRange(portfolioId, minDate)`。
 *
 * 冲突策略（O-3 默认）：
 * - securityTrades / cashFlows：纯 insert 不去重（同日多笔合法）。
 * - assetSnapshots：按 (portfolioId, date) upsert，source 强制 MANUAL；
 *   文件内同日期重复行 → DUPLICATE_SNAPSHOT_DATE（阻断该行，不阻断整体）。
 *
 * 🔴 跨组合安全：export / preview / commit 全部校验 portfolioId 归属；
 *    文件内其它 portfolioId 列一律忽略（以路径参数为准）。
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  Prisma,
  SecuritySide,
  CashFlowType,
  SnapshotSource,
  SnapshotValuation,
} from '@prisma/client';
import {
  ExportType,
  ImportType,
  type ImportRowError,
  type ImportPreviewResult,
  type ImportCommitResult,
  type RecalcSummary,
} from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RecalculationService } from '../recalculation/recalculation.service';
import { todayInAppTz } from '../../common/utils/app-date.util';
import { EXPORT_SCHEMAS, type ExportColumn } from './csv/export-schemas';
import { toCsv, rowToCells, buildExportFilename } from './csv/csv-serializer';
import { toXlsx, XLSX_CONTENT_TYPE } from './csv/xlsx-serializer';
import { parseCsv, type ParsedRow } from './csv/csv-parser';
import { parseXlsx } from './csv/xlsx-parser';
import {
  IMPORT_SCHEMAS,
  validateRow,
  dateFieldsOf,
  type ImportSchema,
} from './csv/import-schemas';
import type { ExportQueryDto } from './dto/export-query.dto';

/** 上传大小上限（5MB） */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** 导入行数上限 */
const MAX_IMPORT_ROWS = 10000;
/** 预览 token 有效期（10 分钟） */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** 预览令牌内存条目 */
interface TokenEntry {
  portfolioId: string;
  type: ImportType;
  rows: ParsedRow[];
  createdAt: number;
}

/** 导出结果 */
export interface ExportResult {
  filename: string;
  contentType: string;
  content: string | Buffer;
}

/** multer 上传文件的最小形态（本仓 @types/express 未声明 Express.Multer，自定义） */
export interface MulterFileLike {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** 允许的上传 MIME（浏览器端 csv/xlsx 五花八门，采用宽松集合并以后缀为主判据） */
const ALLOWED_IMPORT_MIME = new Set([
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.ms-office',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  '',
]);

/** 模板表头 = 导入字段 key（英文） */
function templateColumns(schema: ImportSchema): ExportColumn[] {
  return schema.fields.map((f) => ({ key: f.key, label: f.key }));
}

/** 模板示例行（SET-P0-04：表头 + 1 行示例） */
function exampleRow(schema: ImportSchema): Record<string, string> {
  switch (schema.type) {
    case ImportType.SECURITY_TRADES:
      return {
        securityCode: 'SEC0001',
        date: '2026-01-01',
        side: 'BUY_SEC',
        quantity: '100',
        costPrice: '10.50',
        feeTotal: '5.00',
        note: '示例：买入 100 股',
      };
    case ImportType.CASH_FLOWS:
      return {
        date: '2026-01-01',
        type: 'BUY',
        amount: '10000.00',
        note: '示例：存入本金',
      };
    case ImportType.ASSET_SNAPSHOTS:
      return {
        date: '2026-01-01',
        totalAsset: '100000.00',
        marketValue: '80000.00',
        cashBalance: '20000.00',
        note: '示例：月末估值',
      };
    default:
      return {};
  }
}

@Injectable()
export class DataTransferService {
  private readonly logger = new Logger(DataTransferService.name);
  private readonly tokenStore = new Map<string, TokenEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly recalculationService: RecalculationService,
  ) {}

  /** 验证组合归属（数据隔离） */
  private async verifyOwnership(
    userId: string,
    portfolioId: string,
  ): Promise<void> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
      select: { id: true, name: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }
  }

  // ==========================================================
  // 导出
  // ==========================================================

  /** 导出 7 类数据（CSV / XLSX） */
  async export(
    userId: string,
    portfolioId: string,
    query: ExportQueryDto,
  ): Promise<ExportResult> {
    await this.verifyOwnership(userId, portfolioId);

    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
      select: { name: true },
    });
    if (!portfolio) {
      throw new NotFoundException('组合不存在或无权访问');
    }

    const columns = EXPORT_SCHEMAS[query.type];
    const rawRows = await this.fetchRows(portfolioId, query.type);
    const formatted = rawRows.map((row) => {
      const cells = rowToCells(row, columns);
      const m: Record<string, string> = {};
      columns.forEach((c, i) => {
        m[c.key] = cells[i];
      });
      return m;
    });

    const dateStr = todayInAppTz().toISOString().split('T')[0];
    const format = query.format ?? 'csv';
    const filename = buildExportFilename(
      portfolio.name,
      query.type,
      dateStr,
      format,
    );

    if (format === 'xlsx') {
      return {
        filename,
        contentType: XLSX_CONTENT_TYPE,
        content: toXlsx(formatted, columns),
      };
    }
    return {
      filename,
      contentType: 'text/csv; charset=utf-8',
      content: toCsv(formatted, columns),
    };
  }

  /** 按类型取数（7 类；navSeries 由 DailyNav + DailyXirr + AssetSnapshot 拼装） */
  private async fetchRows(
    portfolioId: string,
    type: ExportType,
  ): Promise<Record<string, unknown>[]> {
    switch (type) {
      case ExportType.SECURITIES:
        return this.prisma.security.findMany({
          where: { portfolioId },
          orderBy: { createdAt: 'asc' },
        });
      case ExportType.SECURITY_TRADES:
        return this.prisma.securityTrade.findMany({
          where: { portfolioId },
          orderBy: { date: 'asc' },
        });
      case ExportType.CASH_FLOWS:
        return this.prisma.cashFlow.findMany({
          where: { portfolioId },
          orderBy: { date: 'asc' },
        });
      case ExportType.CASH_BALANCES:
        return this.prisma.cashBalance.findMany({
          where: { portfolioId },
          orderBy: { asOf: 'asc' },
        });
      case ExportType.SECURITY_PRICES:
        return this.prisma.securityPrice.findMany({
          where: { portfolioId },
          orderBy: { asOf: 'asc' },
        });
      case ExportType.ASSET_SNAPSHOTS:
        return this.prisma.assetSnapshot.findMany({
          where: { portfolioId },
          orderBy: { date: 'asc' },
        });
      case ExportType.NAV_SERIES: {
        const [navs, xirrs, snaps] = await Promise.all([
          this.prisma.dailyNav.findMany({
            where: { portfolioId },
            orderBy: { date: 'asc' },
          }),
          this.prisma.dailyXirr.findMany({
            where: { portfolioId },
            select: { date: true, xirrValue: true },
          }),
          this.prisma.assetSnapshot.findMany({
            where: { portfolioId },
            select: { date: true, totalAsset: true },
          }),
        ]);
        const xirrMap = new Map(
          xirrs.map((x) => [
            x.date.toISOString().split('T')[0],
            x.xirrValue,
          ]),
        );
        const assetMap = new Map(
          snaps.map((s) => [
            s.date.toISOString().split('T')[0],
            s.totalAsset,
          ]),
        );
        return navs.map((n) => {
          const dateKey = n.date.toISOString().split('T')[0];
          return {
            date: n.date,
            cumulativeNav: n.cumulativeNav,
            yearNav: n.yearNav,
            shares: n.shares,
            totalAsset: assetMap.get(dateKey) ?? '',
            xirr: xirrMap.get(dateKey) ?? '',
          };
        });
      }
      default:
        throw new BadRequestException(`不支持的导出类型: ${type}`);
    }
  }

  // ==========================================================
  // 模板下载（SET-P0-04 · 3 类，CSV / XLSX 双格式）
  // ==========================================================

  /** 生成导入模板（表头 + 1 行示例） */
  template(
    type: ImportType,
    format: 'csv' | 'xlsx',
  ): ExportResult {
    const schema = IMPORT_SCHEMAS[type];
    const columns = templateColumns(schema);
    const example = exampleRow(schema);
    const comment = '示例行（可删除后填写真实数据）；列名与导出文件一致';
    const filename = `${type}-template-${todayInAppTz()
      .toISOString()
      .split('T')[0]}.${format}`;

    if (format === 'xlsx') {
      return {
        filename,
        contentType: XLSX_CONTENT_TYPE,
        content: toXlsx([example], columns, comment),
      };
    }
    return {
      filename,
      contentType: 'text/csv; charset=utf-8',
      content: toCsv([example], columns, comment),
    };
  }

  // ==========================================================
  // 导入：阶段一 预览（不落库）
  // ==========================================================

  /** 文件校验（MIME + 后缀双校验；大小 ≤ 5MB） */
  private validateImportFile(
    file: MulterFileLike | undefined,
  ): void {
    if (!file) {
      throw new BadRequestException('请选择要导入的文件');
    }
    if (file.size > MAX_IMPORT_BYTES) {
      throw new BadRequestException('文件超过大小上限（5MB）');
    }
    const name = file.originalname ?? '';
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      throw new BadRequestException('仅支持 .csv / .xlsx / .xls 文件');
    }
    const mime = file.mimetype ?? '';
    if (!ALLOWED_IMPORT_MIME.has(mime)) {
      throw new BadRequestException('文件类型不被支持');
    }
  }

  /** 按扩展名分流解析（CSV → papaparse；XLSX → xlsx） */
  private parseImportFile(
    file: MulterFileLike,
    schema: ImportSchema,
  ): ParsedRow[] {
    const name = file.originalname ?? '';
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (ext === 'csv') {
      return parseCsv(file.buffer.toString('utf8'));
    }
    return parseXlsx(file.buffer, dateFieldsOf(schema));
  }

  /** 预览（不写库）：解析 → 行级校验 → 前 10 行 + 全量错误 + token */
  async preview(
    userId: string,
    portfolioId: string,
    type: ImportType,
    file: MulterFileLike | undefined,
  ): Promise<ImportPreviewResult> {
    await this.verifyOwnership(userId, portfolioId);
    this.validateImportFile(file);
    const schema = IMPORT_SCHEMAS[type];
    const rows = this.parseImportFile(file!, schema);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `导入行数超过上限（${MAX_IMPORT_ROWS}），请分批导入`,
      );
    }

    const securities = await this.prisma.security.findMany({
      where: { portfolioId },
      select: { code: true },
    });
    const codeSet = new Set(securities.map((s) => s.code));

    const errors: ImportRowError[] = [];
    const validRows: ParsedRow[] = [];
    const seenDates = new Set<string>();

    for (const row of rows) {
      const rowErrors = validateRow(schema, row, codeSet, seenDates);
      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
      } else {
        if (schema.type === ImportType.ASSET_SNAPSHOTS) {
          seenDates.add(row.data.date);
        }
        validRows.push(row);
      }
    }

    const dateField = schema.fields.find((f) => f.type === 'date');
    let minDate: string | null = null;
    if (dateField) {
      for (const row of validRows) {
        const d = row.data[dateField.key];
        if (d && (!minDate || d < minDate)) minDate = d;
      }
    }

    const token = randomUUID();
    this.tokenStore.set(token, {
      portfolioId,
      type,
      rows: validRows,
      createdAt: Date.now(),
    });
    this.cleanupTokens();

    return {
      type,
      totalRows: rows.length,
      validRows: validRows.length,
      sample: validRows.slice(0, 10).map((r) => r.data),
      errors,
      minDate,
      token,
    };
  }

  // ==========================================================
  // 导入：阶段二 提交（单事务 + 单次重算）
  // ==========================================================

  /** 提交：单 Prisma 事务写入 → 事务外只调一次 recalculateNavRange */
  async commit(
    userId: string,
    portfolioId: string,
    type: ImportType,
    token: string,
  ): Promise<ImportCommitResult> {
    await this.verifyOwnership(userId, portfolioId);

    const entry = this.tokenStore.get(token);
    if (!entry) {
      throw new BadRequestException('导入预览已过期，请重新上传');
    }
    if (entry.portfolioId !== portfolioId || entry.type !== type) {
      throw new BadRequestException('导入预览与当前请求不匹配，请重新上传');
    }
    this.tokenStore.delete(token);

    const schema = IMPORT_SCHEMAS[type];
    const rows = entry.rows;
    if (rows.length === 0) {
      return {
        inserted: 0,
        updated: 0,
        skipped: 0,
        failed: [],
        recalculated: null,
      };
    }

    // 解析 securityId（securityTrades 需要外键）
    let codeToId = new Map<string, string>();
    if (schema.securityCodeField) {
      const securities = await this.prisma.security.findMany({
        where: { portfolioId },
        select: { id: true, code: true },
      });
      codeToId = new Map(securities.map((s) => [s.code, s.id]));
    }

    const dateField = schema.fields.find((f) => f.type === 'date');
    let minDate: string | null = null;
    if (dateField) {
      for (const row of rows) {
        const d = row.data[dateField.key];
        if (d && (!minDate || d < minDate)) minDate = d;
      }
    }

    let inserted = 0;
    let updated = 0;
    const failed: ImportRowError[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const data = row.data;
        try {
          if (schema.type === ImportType.SECURITY_TRADES) {
            const securityId = codeToId.get(data.securityCode ?? '');
            if (!securityId) {
              failed.push({
                row: row.rowNumber,
                field: 'securityCode',
                code: 'SECURITY_NOT_FOUND',
                message: `标的不存在：${data.securityCode}`,
              });
              continue;
            }
            await tx.securityTrade.create({
              data: {
                portfolioId,
                securityId,
                date: new Date(`${data.date}T00:00:00.000Z`),
                side: data.side as SecuritySide,
                quantity: new Prisma.Decimal(data.quantity),
                costPrice: new Prisma.Decimal(data.costPrice),
                commission: new Prisma.Decimal(data.feeTotal || '0'),
                stampTax: new Prisma.Decimal('0'),
                other: new Prisma.Decimal('0'),
                feeTotal: new Prisma.Decimal(data.feeTotal || '0'),
                note: data.note || null,
              },
            });
            inserted += 1;
          } else if (schema.type === ImportType.CASH_FLOWS) {
            await tx.cashFlow.create({
              data: {
                portfolioId,
                date: new Date(`${data.date}T00:00:00.000Z`),
                type: data.type as CashFlowType,
                amount: new Prisma.Decimal(data.amount),
                note: data.note || null,
              },
            });
            inserted += 1;
          } else if (schema.type === ImportType.ASSET_SNAPSHOTS) {
            const date = new Date(`${data.date}T00:00:00.000Z`);
            const totalAsset = new Prisma.Decimal(data.totalAsset);
            const marketValue = data.marketValue
              ? new Prisma.Decimal(data.marketValue)
              : null;
            const cashBalance = data.cashBalance
              ? new Prisma.Decimal(data.cashBalance)
              : null;
            const payload = {
              totalAsset,
              marketValue,
              cashBalance,
              source: 'MANUAL' as SnapshotSource,
              valuationFlag: 'MANUAL_INPUT' as SnapshotValuation,
              note: data.note || null,
              recordedAt: new Date(),
            };
            const existing = await tx.assetSnapshot.findUnique({
              where: { portfolioId_date: { portfolioId, date } },
              select: { id: true },
            });
            if (existing) updated += 1;
            else inserted += 1;
            await tx.assetSnapshot.upsert({
              where: { portfolioId_date: { portfolioId, date } },
              create: { portfolioId, date, ...payload },
              update: payload,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `导入行写入失败：portfolioId=${portfolioId} row=${row.rowNumber} reason=${message}`,
          );
          failed.push({
            row: row.rowNumber,
            field: null,
            code: 'INVALID_FILE_TYPE',
            message: `写入失败：${message}`,
          });
        }
      }
    });

    // 🔴 全流程仅 1 次重算（事务外；铁律）
    let recalculated: RecalcSummary | null = null;
    if (inserted + updated > 0 && minDate) {
      const days = await this.recalculationService.recalculateNavRange(
        portfolioId,
        new Date(`${minDate}T00:00:00.000Z`),
      );
      recalculated = {
        fromDate: minDate,
        toDate: todayInAppTz().toISOString().split('T')[0],
        recalculatedDays: days,
      };
    }

    return { inserted, updated, skipped: 0, failed, recalculated };
  }

  /** 清理过期 token（每次预览 / 提交前调用） */
  private cleanupTokens(): void {
    const now = Date.now();
    for (const [key, entry] of this.tokenStore) {
      if (now - entry.createdAt > TOKEN_TTL_MS) {
        this.tokenStore.delete(key);
      }
    }
  }
}
