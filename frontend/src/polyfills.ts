// Node-global polyfills for the Midnight SDK, which reads `Buffer` and
// `process` at module-initialization time. This module must be imported
// FIRST in main.tsx: ES module side effects run in source order, depth-first,
// so importing it before ./App.tsx guarantees these globals exist before any
// SDK module that touches them is evaluated. (`global` is handled at compile
// time via `define` in vite.config.ts.)
import { Buffer } from 'buffer';
import processShim from 'process';

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.process) globalThis.process = processShim;
