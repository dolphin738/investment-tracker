/**
 * 上传模块本地类型
 *
 * 刻意不依赖 @types/multer（`Express.Multer.File` 全局命名空间扩展）：
 * 该 devDependency 在部分环境下装不上，一旦缺失整个后端 tsc 会红。
 * 这里用结构化类型描述 multer memoryStorage 产出的文件对象，
 * 字段与 Express.Multer.File 的子集完全一致，运行期零差异。
 *
 * 另一个好处：@UploadedFile() 参数用 type alias 声明时，
 * emitDecoratorMetadata 产出的 design:paramtypes 是 Object，
 * 全局 ValidationPipe 的 toValidate() 会跳过它，不会误校验文件对象。
 */

/** multer 内存存储产出的上传文件对象（Express.Multer.File 的结构化子集） */
export interface UploadedFileLike {
  /** 表单字段名，固定为 'file' */
  fieldname: string;
  /** 客户端原始文件名 —— 仅用于日志，绝不参与落盘路径拼接 */
  originalname: string;
  /** 客户端声明的 MIME 类型（可伪造，必须再做魔数嗅探） */
  mimetype: string;
  /** 文件二进制内容（memoryStorage 模式下必定存在） */
  buffer: Buffer;
  /** 文件字节数 */
  size: number;
}
