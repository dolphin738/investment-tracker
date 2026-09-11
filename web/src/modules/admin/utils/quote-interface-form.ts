/**
 * modules/admin/utils/quote-interface-form.ts — 接口对话框表单模型与转换（纯逻辑）
 *
 * 从 QuoteInterfaceDialog.vue 抽出：FormState / toForm / buildResponseParse /
 * buildSubmitPayload。对话框只保留交互与提交，模型与 payload 组装集中在此，
 * 便于单测覆盖（含 response_fields 回填与「全空返回 null」约定）。
 */
import type { QuoteInterface } from '@/api/quote-interface.api';
import {
  buildResponseFields,
  emptyFieldRow,
  fieldRowsFromLegacyColumns,
  fieldRowsFromSpecs,
  type FieldMappingRow,
} from './response-fields';

/** 参数模板行（与接口测试面板一致：键值对增删） */
export interface ParamRow {
  key: string;
  value: string;
}

/** 接口对话框表单状态（4 个页签全部字段） */
export interface FormState {
  categoryId: string;
  name: string;
  endpoint: string;
  httpMethod: string;
  params: ParamRow[];
  enabled: boolean;
  description: string;
  timeout: string;
  retryCount: string;
  rateLimit: string;
  assetClass: string[];
  // —— 旧 4 列响应字段：仅作回滚镜像展示与 payload 兼容，编辑由映射表承担 ——
  respCodeField: string;
  respPriceField: string;
  respNameField: string;
  respExchangeField: string;
  // —— 响应字段映射表（新结构，方案 §7）——
  fieldRows: FieldMappingRow[];
  // —— 响应解析协议（覆盖非 JSON 文本源，如腾讯财经 ~ 分隔）——
  rpFormat: string;
  rpEncoding: string;
  rpSep: string;
  rpLineRegex: string;
  rpCodeParam: string;
  rpCodePrefix: string;
}

/** 由表单的响应解析协议字段拼成 response_parse 对象（全空则返回 null） */
export function buildResponseParse(form: FormState): Record<string, string> | null {
  const rp: Record<string, string> = {};
  if (form.rpFormat.trim()) rp.format = form.rpFormat.trim();
  // 仅文本分隔格式才需要编码/分隔符/行提取正则；json 不持久化这些字段
  if (form.rpFormat === 'text_split') {
    if (form.rpEncoding.trim()) rp.encoding = form.rpEncoding.trim();
    if (form.rpSep.trim()) rp.sep = form.rpSep.trim();
    if (form.rpLineRegex.trim()) rp.line_regex = form.rpLineRegex.trim();
  }
  if (form.rpCodeParam.trim()) rp.code_param = form.rpCodeParam.trim();
  if (form.rpCodePrefix.trim()) rp.code_prefix = form.rpCodePrefix.trim();
  return Object.keys(rp).length ? rp : null;
}

/** 从 response_parse 提取 resp_date_field（旧「第二真相」，历史兼容用） */
function legacyDateField(edit: QuoteInterface): string | null {
  const rp = edit.response_parse ?? {};
  const v = rp.resp_date_field;
  return typeof v === 'string' && v ? v : null;
}

/**
 * 编辑态 / 新增态表单初始化。
 *
 * 字段映射行回填优先级：response_fields（新结构）→ 旧 4 列 + resp_date_field 镜像
 * 预填（后端 fold_legacy_columns 的前端镜像，用户保存后即落新结构）→ 新增态给 1 空行。
 */
export function toForm(edit: QuoteInterface | null): FormState {
  const fieldRows = !edit
    ? [emptyFieldRow()]
    : edit.response_fields && edit.response_fields.length > 0
      ? fieldRowsFromSpecs(edit.response_fields)
      : fieldRowsFromLegacyColumns({
          categoryId: edit.category_id,
          respCodeField: edit.resp_code_field,
          respPriceField: edit.resp_price_field,
          respNameField: edit.resp_name_field,
          respExchangeField: edit.resp_exchange_field,
          respDateField: legacyDateField(edit),
        });
  if (!edit) {
    return {
      categoryId: '',
      name: '',
      endpoint: '',
      httpMethod: '',
      params: [{ key: '', value: '' }],
      enabled: true,
      description: '',
      timeout: '',
      retryCount: '',
      rateLimit: '',
      assetClass: [],
      respCodeField: '',
      respPriceField: '',
      respNameField: '',
      respExchangeField: '',
      fieldRows,
      rpFormat: 'json',
      rpEncoding: '',
      rpSep: '~',
      rpLineRegex: '',
      rpCodeParam: '',
      rpCodePrefix: '',
    };
  }
  return {
    categoryId: edit.category_id ?? '',
    name: edit.name,
    endpoint: edit.endpoint ?? '',
    httpMethod: edit.http_method ?? '',
    params:
      edit.params && typeof edit.params === 'object'
        ? Object.entries(edit.params as Record<string, unknown>).map(
            ([k, v]) => ({ key: k, value: v == null ? '' : String(v) }),
          )
        : [{ key: '', value: '' }],
    enabled: edit.enabled,
    description: edit.description ?? '',
    timeout: edit.timeout != null ? String(edit.timeout) : '',
    retryCount: edit.retry_count != null ? String(edit.retry_count) : '',
    rateLimit: edit.rate_limit ?? '',
    assetClass: edit.asset_class ?? [],
    respCodeField: edit.resp_code_field ?? '',
    respPriceField: edit.resp_price_field ?? '',
    respNameField: edit.resp_name_field ?? '',
    respExchangeField: edit.resp_exchange_field ?? '',
    fieldRows,
    rpFormat: (edit.response_parse?.format as string) ?? 'json',
    rpEncoding: (edit.response_parse?.encoding as string) ?? '',
    rpSep: (edit.response_parse?.sep as string) ?? '~',
    rpLineRegex: (edit.response_parse?.line_regex as string) ?? '',
    rpCodeParam: (edit.response_parse?.code_param as string) ?? '',
    rpCodePrefix: (edit.response_parse?.code_prefix as string) ?? '',
  };
}

/** 表单 → 提交 payload（Create / Update 共用；旧 4 列随行携带以兼容后端双写） */
export function buildSubmitPayload(form: FormState): Record<string, unknown> {
  const parsedParams: Record<string, unknown> = {};
  form.params.forEach((r) => {
    const k = r.key.trim();
    if (k) parsedParams[k] = r.value;
  });
  return {
    category_id: form.categoryId.trim(),
    name: form.name.trim(),
    endpoint: form.endpoint.trim() || null,
    http_method:
      form.httpMethod && form.httpMethod !== '__none__'
        ? form.httpMethod
        : null,
    params: parsedParams,
    enabled: form.enabled,
    description: form.description.trim() || null,
    timeout: form.timeout.trim() ? Number(form.timeout) : null,
    retry_count: form.retryCount.trim() ? Number(form.retryCount) : null,
    rate_limit: form.rateLimit.trim() || null,
    asset_class: form.assetClass.length ? [...form.assetClass] : null,
    resp_code_field: form.respCodeField.trim() || null,
    resp_price_field: form.respPriceField.trim() || null,
    resp_name_field: form.respNameField.trim() || null,
    resp_exchange_field: form.respExchangeField.trim() || null,
    response_fields: buildResponseFields(form.fieldRows),
    response_parse: buildResponseParse(form),
  };
}

/**
 * 老数据（response_fields 为 NULL）时旧 4 列镜像是否需要只读展示：
 * 至少一列非空才展示，避免新增/已迁移接口出现空面板。
 */
export function hasLegacyMirror(edit: QuoteInterface | null): boolean {
  if (!edit || (edit.response_fields != null && edit.response_fields.length > 0)) {
    return false;
  }
  const rp = edit.response_parse ?? {};
  return Boolean(
    edit.resp_code_field ||
      edit.resp_price_field ||
      edit.resp_name_field ||
      edit.resp_exchange_field ||
      rp.resp_date_field,
  );
}
