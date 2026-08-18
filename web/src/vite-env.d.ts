/// <reference types="vite/client" />

// Vue 单文件组件类型声明：让 TS 认识 .vue 模块导入
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
