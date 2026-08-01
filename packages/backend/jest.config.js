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
    // K2：shared 源码用 ESM 风格的 `./types/user.js` 相对导入（NodeNext 规范），
    // ts-jest 以 CommonJS 解析时找不到实际不存在的 .js 文件 → 剥掉扩展名后再解析。
    // 缺此映射会导致依赖 shared 的 spec（如 query.service.spec.ts）整体加载失败。
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  moduleFileExtensions: ['js', 'ts', 'json'],
};
