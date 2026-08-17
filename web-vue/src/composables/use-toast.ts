/**
 * composables/use-toast.ts — toast 通知统一出口
 *
 * vue-sonner 的 toast 函数为命令式 API，无需 composable 包装即可使用；
 * 此处统一 re-export 并约定全站从本模块导入，便于后续统一追加配置
 * （如全局 duration、主题适配）而不必逐文件替换。
 */

export { toast } from 'vue-sonner';
