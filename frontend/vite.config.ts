import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Note: Vite 8 bundles with Rolldown, which vite-plugin-node-polyfills does
// not yet support (its shim imports fail to resolve). So the Midnight SDK's
// Node dependencies are polyfilled by hand: Buffer/process globals in
// main.tsx, `global` via define, and Node's `crypto` aliased below.
export default defineConfig({
  plugins: [react()],
  define: { global: 'globalThis' },
  resolve: {
    // The Midnight WASM packages are installed twice (once here, once in the
    // repo-root node_modules that contracts/managed/** imports). Two physical
    // copies of a WASM module mean two class registries, so an instance made
    // by one fails the other's `_assertClass` check ("expected instance of
    // ContractMaintenanceAuthority"). Force a single copy of each.
    dedupe: [
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/zkir-v2',
    ],
    // midnight-js-level-private-state-provider encrypts private state at rest
    // with Node's synchronous crypto (createHash/pbkdf2Sync/createCipheriv).
    // WebCrypto is async and can't replace it, so map `crypto` to the browser
    // polyfill — which in turn needs Node's `stream`/`util` (cipher-base and
    // create-hash extend stream.Transform), so alias those too. Without them
    // Vite externalizes `stream`/`util` to empty stubs and `stream.Transform`
    // is undefined, surfacing as "Cannot read properties of undefined
    // (reading 'call')" inside inherits().
    alias: {
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      util: 'util',
    },
  },
  optimizeDeps: {
    // WASM-bound packages break under dev-mode pre-bundling
    // ("Cannot access '__wbindgen_start' before initialization").
    exclude: [
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/zkir-v2',
    ],
  },
})
