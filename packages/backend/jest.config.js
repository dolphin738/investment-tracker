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
  },
  moduleFileExtensions: ['js', 'ts', 'json'],
};
