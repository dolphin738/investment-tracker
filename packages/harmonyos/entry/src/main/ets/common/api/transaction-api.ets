/**
 * 交易管理 API — CRUD transactions
 *
 * 对应后端端点：
 * - GET    /api/portfolios/:portfolioId/transactions           获取交易列表
 * - POST   /api/portfolios/:portfolioId/transactions           录入交易
 * - PATCH  /api/portfolios/:portfolioId/transactions/:id       编辑交易
 * - DELETE /api/portfolios/:portfolioId/transactions/:id       删除交易
 *
 * 副作用：创建/编辑/删除交易后，若当日已有资产快照，后端自动触发当日净值+XIRR 重算。
 *        修改历史交易时触发从该日期起的批量重算。
 */

import { HttpClient } from '../net/http-client';
import { ApiConfig } from '../net/api-config';
import type {
  CreateTransactionRequest,
  Paginated,
  Transaction,
  TransactionType,
  UpdateTransactionRequest,
} from '../net/api-types';

export class TransactionApi {
  /**
   * 获取交易列表（分页）
   * @param portfolioId 组合 ID
   * @param page 页码（默认 1）
   * @param pageSize 每页条数（默认 50）
   * @param startDate 起始日期（可选，YYYY-MM-DD）
   * @param endDate 结束日期（可选，YYYY-MM-DD）
   */
  static async list(
    portfolioId: string,
    page: number = 1,
    pageSize: number = 50,
    startDate?: string,
    endDate?: string,
  ): Promise<Paginated<Transaction>> {
    let path: string = `${ApiConfig.transactions(portfolioId)}?page=${page}&pageSize=${pageSize}`;
    if (startDate) {
      path += `&startDate=${startDate}`;
    }
    if (endDate) {
      path += `&endDate=${endDate}`;
    }
    return HttpClient.get<Paginated<Transaction>>(path);
  }

  /**
   * 录入交易
   * @param portfolioId 组合 ID
   * @param date 交易日期 YYYY-MM-DD
   * @param type 交易类型 BUY / SELL
   * @param amount 交易金额（字符串，如 "10000.00"）
   * @param note 备注（可选）
   */
  static async create(
    portfolioId: string,
    date: string,
    type: TransactionType,
    amount: string,
    note?: string,
  ): Promise<Transaction> {
    const body: CreateTransactionRequest = {
      date: date,
      type: type,
      amount: amount,
    };
    if (note && note.length > 0) {
      body.note = note;
    }
    return HttpClient.post<Transaction>(ApiConfig.transactions(portfolioId), body);
  }

  /**
   * 编辑交易
   */
  static async update(
    portfolioId: string,
    txId: string,
    data: UpdateTransactionRequest,
  ): Promise<Transaction> {
    return HttpClient.patch<Transaction>(
      ApiConfig.transactionDetail(portfolioId, txId),
      data,
    );
  }

  /**
   * 删除交易
   */
  static async delete(portfolioId: string, txId: string): Promise<void> {
    await HttpClient.delete<void>(ApiConfig.transactionDetail(portfolioId, txId));
  }
}
