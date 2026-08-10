/** dsh-loop 双 half 构建：Node（命令/工具/路由）+ 官方 client bundle。 */

export default [
  {
    entry: ['src/index.mjs'],
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    outDir: 'lib',
    clean: true,
  },
  {
    entry: ['src/client/index.tsx'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    external: [/@deepseek-ai\/dsh-client-/, 'react', 'react-dom'],
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-external/dsh-loop", factory: (require) => {',
    footer: 'return module.exports; } });',
  },
]
