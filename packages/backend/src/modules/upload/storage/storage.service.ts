/**
 * 存储驱动抽象
 *
 * 上层（UploadService）只依赖本抽象类，不感知本地磁盘 / 对象存储的差异。
 * 后续接入腾讯云 COS / AWS S3 时新增一个子类并在 UploadModule 的 factory 里切换即可，
 * 业务代码零改动。
 *
 * 契约说明：
 * - save()        写入二进制内容，返回对外 URL 与内部定位符
 * - resolvePath() 把对外 URL 还原为内部定位符（本地=绝对路径，对象存储=objectKey）
 * - remove()      按内部定位符删除，调用前必须先过 canRemove()
 * - canRemove()   安全闸门，只允许删除「本驱动自己生成的」资源，防路径穿越/越权删除
 */

/** save() 的返回结果 */
export interface StoredFile {
  /** 对外可访问的 URL（相对路径，如 /api/uploads/avatar/<uuid>.png） */
  url: string;
  /** 内部定位符：本地磁盘为文件绝对路径 */
  path: string;
}

export abstract class StorageService {
  /**
   * 保存二进制内容
   *
   * @param buffer 文件内容
   * @param ext 由魔数嗅探推导出的扩展名（不含点号），绝不使用客户端提供的文件名
   * @returns 对外 URL + 内部定位符
   */
  abstract save(buffer: Buffer, ext: string): Promise<StoredFile>;

  /**
   * 删除资源
   *
   * @param absPath 内部定位符（本地磁盘为绝对路径）
   */
  abstract remove(absPath: string): Promise<void>;

  /**
   * 判断给定 URL 是否是本驱动托管、且可以安全删除的资源。
   *
   * @param url 数据库里存的头像地址（可能是外链 http(s)://，也可能是历史脏数据）
   */
  abstract canRemove(url: string): boolean;

  /**
   * 把对外 URL 还原为内部定位符，供 remove() 使用。
   *
   * 调用方必须先用 canRemove() 校验；未通过校验时本方法的返回值不可信。
   *
   * @param url 对外 URL
   * @returns 内部定位符（本地磁盘为绝对路径）
   */
  abstract resolvePath(url: string): string;
}
