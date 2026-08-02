/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // shared package is TypeScript source (main: ./src/index.ts), must be transformed
  transformIgnorePatterns: [
    'node_modules/(?!@investment-tracker/shared)',
  ],
  moduleNameMapper: {
    '^@investment-tracker/shared$': '<rootDir>/../shared/src/index.ts',
    // finance-core：零依赖纯函数库，测试期直接映射到 TS 源码，
    // 免去「跑 backend 单测前必须先 build finance-core」的隐式前置条件。
    // 子路径 /testing 必须排在主入口之前，顺序不可颠倒。
    '^@investment-tracker/finance-core/testing$':
      '<rootDir>/../finance-core/src/testing/index.ts',
    '^@investment-tracker/finance-core$': '<rootDir>/../finance-core/src/index.ts',
    // K2：shared 源码用 ESM 风格的 `./types/user.js` 相对导入（NodeNext 规范），
    // ts-jest 以 CommonJS 解析时找不到实际不存在的 .js 文件 → 剥掉扩展名后再解析。
    // 缺此映射会导致依赖 shared 的 spec（如 query.service.spec.ts）整体加载失败。
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  moduleFileExtensions: ['js', 'ts', 'json'],
};
