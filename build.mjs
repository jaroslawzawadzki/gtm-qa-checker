// Builds every extension entry point as a standalone IIFE bundle.
// Content scripts and MAIN-world scripts cannot use ES module imports,
// so each entry is bundled separately into dist/.
import { build } from 'vite';
import { copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const watch = process.argv.includes('--watch');
// --prod: smaller bundles for distribution (no inline source maps, minified).
const prod = process.argv.includes('--prod');
const outDir = resolve('dist');

const entries = {
  injected: 'src/injected/injected.ts',
  content: 'src/content/content.ts',
  preview: 'src/preview/preview.ts',
  background: 'src/background/serviceWorker.ts',
};

await rm(outDir, { recursive: true, force: true });

let first = true;
for (const [name, entry] of Object.entries(entries)) {
  await build({
    configFile: false,
    logLevel: 'warn',
    // public/ (manifest.json) is copied once, with the first bundle.
    publicDir: first ? 'public' : false,
    build: {
      outDir,
      // Never empty per-entry: in watch mode a rebuild would wipe the other bundles.
      emptyOutDir: false,
      minify: prod,
      sourcemap: prod ? false : 'inline',
      target: 'chrome114',
      lib: {
        entry: resolve(entry),
        formats: ['iife'],
        name: `gtmqa_${name}`,
        fileName: () => `${name}.js`,
      },
      watch: watch ? {} : null,
    },
  });
  console.log(`✓ ${name}.js`);
  first = false;
}

// Installation guide (kept in the repo root so it is visible on GitHub) goes into the ZIP too.
await copyFile('INSTALL.txt', resolve(outDir, 'INSTALL.txt'));

if (watch) console.log('Watching for changes…');
