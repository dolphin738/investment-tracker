/**
 * 更新交易 DTO
 *
 * 所有字段可选。更新交易后服务端会触发批量重算。
 */

import { PartialType } from '@nestjs/swagger';
import { CreateTransactionDto } from './create-transaction.dto';

export class UpdateTransactionDto extends PartialType(CreateTransactionDto) {}
