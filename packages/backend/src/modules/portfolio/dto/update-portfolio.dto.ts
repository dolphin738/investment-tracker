/**
 * 更新组合 DTO
 *
 * 所有字段可选，仅允许更新 name 和 description。
 * currency 和 baseDate 不可通过此接口修改。
 */

import { PartialType } from '@nestjs/swagger';
import { CreatePortfolioDto } from './create-portfolio.dto';

export class UpdatePortfolioDto extends PartialType(CreatePortfolioDto) {}
