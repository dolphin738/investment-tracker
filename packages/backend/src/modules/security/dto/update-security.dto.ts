/**
 * 更新标的 DTO
 *
 * 所有字段可选，仅允许更新 code / name / type / currency。
 */

import { PartialType } from '@nestjs/swagger';
import { CreateSecurityDto } from './create-security.dto';

export class UpdateSecurityDto extends PartialType(CreateSecurityDto) {}
