/**
 * dsh-tunnelmux-remote build: three bundles.
 * - lib/index.js  — host half (cordis plugin: pairing, routes, mobile page,
 *                   TunnelMux auto-tunnel). Node ESM.
 * - lib/mobile.js — standalone mobile bundle (no module loader; react inlined)
 *                   served by the host at /m/mobile.js.
 * - client/client.js — browser client half (sidebar QR entry), a closure
 *                   factory calling window.__ModuleLoader__.load with react
 *                   resolved through the loader module table.
 */
import { defineConfig } from 'tsdown'

const id = 'dsh-tunnelmux-remote'
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-apiproxy',
      'schemastery',
      'zod',
    ],
  },
  {
    entry: { mobile: 'src/mobile-app/index.tsx' },
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [],
    noExternal: /.*/,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'client',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (source) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
