import { defineConfig, type Plugin, build as viteBuild } from 'vite';
import { resolve } from 'path';
import { copyFileSync, cpSync, mkdirSync, existsSync, writeFileSync } from 'fs';

/**
 * Write a fresh random build hash into dist/.build-hash on every bundle.
 * The service worker polls this file (see startDevAutoReload in service-
 * worker.ts) and calls chrome.runtime.reload() when the value changes.
 * This gives automatic extension reload on every `vite build --watch`
 * iteration so you don't have to click the refresh button by hand.
 *
 * Runs on BOTH the main build and the IIFE content-script build so the
 * marker updates after the full pipeline finishes (the content script
 * IIFE build is the slowest step, and the SW only needs one fresh write
 * per rebuild cycle — the last writer wins).
 */
function writeBuildHash(): Plugin {
  return {
    name: 'write-build-hash',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
      const hash = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      writeFileSync(resolve(dist, '.build-hash'), hash);
    },
  };
}

/**
 * Plugin that:
 * 1. Copies static extension assets into dist/ after build
 * 2. Builds content scripts as separate IIFE bundles (no shared chunks)
 */
function copyExtensionAssets(): Plugin {
  return {
    name: 'copy-extension-assets',
    writeBundle() {
      const src = resolve(__dirname);
      const dist = resolve(__dirname, 'dist');

      copyFileSync(resolve(src, 'manifest.json'), resolve(dist, 'manifest.json'));

      for (const dir of ['sidepanel', 'popup', 'icons']) {
        const srcDir = resolve(src, dir);
        const destDir = resolve(dist, dir);
        if (existsSync(srcDir)) {
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
        }
      }

      // v0.57.36: vite's parallel build pipeline (main build + 6 IIFE
      // content-script builds, each running closeBundle hooks) intermittently
      // truncated dist/icons/icon-128.png to 0 bytes — causing
      // "Could not load icon 'icons/icon-128.png'" on extension load.
      // Verify each icon's size matches the source after the recursive
      // cpSync; if it doesn't, copyFileSync the single file directly.
      // Cheap: ~4 stat calls + 0-1 copies per build.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { statSync } = require('fs');
        const iconSrc = resolve(src, 'icons');
        const iconDist = resolve(dist, 'icons');
        if (existsSync(iconSrc) && existsSync(iconDist)) {
          for (const f of ['icon-16.png', 'icon-48.png', 'icon-128.png']) {
            const sPath = resolve(iconSrc, f);
            const dPath = resolve(iconDist, f);
            if (!existsSync(sPath)) continue;
            const sSize = statSync(sPath).size;
            const dSize = existsSync(dPath) ? statSync(dPath).size : -1;
            if (sSize !== dSize) {
              copyFileSync(sPath, dPath);
              const after = statSync(dPath).size;
              if (after !== sSize) {
                console.warn(`[vite-plugin] Icon copy verification failed for ${f}: src=${sSize} dst=${after}`);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[vite-plugin] Icon size verification failed:', (e as Error).message);
      }
    },
  };
}

/**
 * Plugin that builds each MAIN world content script as a separate
 * self-contained IIFE bundle after the main build completes.
 * This prevents shared chunks that break in MAIN world injection.
 */
function buildContentScriptsIIFE(): Plugin {
  return {
    name: 'build-content-iife',
    async closeBundle() {
      const contentScripts = [
        { name: 'sniffies', entry: resolve(__dirname, 'content/sniffies.ts') },
        { name: 'grindr', entry: resolve(__dirname, 'content/grindr.ts') },
        { name: 'doublelist', entry: resolve(__dirname, 'content/doublelist.ts') },
        { name: 'adam4adam', entry: resolve(__dirname, 'content/adam4adam.ts') },
        { name: 'gmail', entry: resolve(__dirname, 'content/gmail.ts') },
        { name: 'yahoo', entry: resolve(__dirname, 'content/yahoo.ts') },
      ];

      for (const { name, entry } of contentScripts) {
        await viteBuild({
          configFile: false,
          build: {
            outDir: resolve(__dirname, 'dist/content'),
            emptyOutDir: false,
            sourcemap: true,
            target: 'es2022',
            minify: false,
            lib: {
              entry,
              name: `aggregaytor_${name}`,
              formats: ['iife'],
              fileName: () => `${name}.js`,
            },
            rollupOptions: {
              output: {
                inlineDynamicImports: true,
              },
            },
          },
          resolve: {
            alias: {
              '@aggregaytor/context-engine': resolve(__dirname, '../../packages/context-engine/src/index.ts'),
              '@aggregaytor/adapter-core': resolve(__dirname, '../../packages/adapter-core/src/index.ts'),
              '@aggregaytor/adapter-sniffies': resolve(__dirname, '../../adapters/sniffies/src/index.ts'),
              '@aggregaytor/adapter-grindr': resolve(__dirname, '../../adapters/grindr/src/index.ts'),
              '@aggregaytor/adapter-doublelist': resolve(__dirname, '../../adapters/doublelist/src/index.ts'),
              '@aggregaytor/adapter-adam4adam': resolve(__dirname, '../../adapters/adam4adam/src/index.ts'),
              '@aggregaytor/adapter-gmail': resolve(__dirname, '../../adapters/gmail/src/index.ts'),
              '@aggregaytor/adapter-yahoo': resolve(__dirname, '../../adapters/yahoo/src/index.ts'),
            },
          },
          logLevel: 'warn',
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [copyExtensionAssets(), buildContentScriptsIIFE(), writeBuildHash()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      // Only build service worker + bridge/migrate scripts in the main build.
      // MAIN world content scripts (sniffies.js, grindr.js) are built separately as IIFE.
      input: {
        'background/service-worker': resolve(__dirname, 'background/service-worker.ts'),
        'content/sniffies-bridge': resolve(__dirname, 'content/sniffies-bridge.ts'),
        'content/sniffies-migrate': resolve(__dirname, 'content/sniffies-migrate.ts'),
        'content/grindr-bridge': resolve(__dirname, 'content/grindr-bridge.ts'),
        'content/doublelist-bridge': resolve(__dirname, 'content/doublelist-bridge.ts'),
        'content/adam4adam-bridge': resolve(__dirname, 'content/adam4adam-bridge.ts'),
        'content/gmail-bridge': resolve(__dirname, 'content/gmail-bridge.ts'),
        'content/yahoo-bridge': resolve(__dirname, 'content/yahoo-bridge.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        format: 'es',
      },
    },
  },
  resolve: {
    alias: {
      events: 'events',
      '@aggregaytor/context-engine': resolve(__dirname, '../../packages/context-engine/src/index.ts'),
      '@aggregaytor/adapter-core': resolve(__dirname, '../../packages/adapter-core/src/index.ts'),
      '@aggregaytor/store': resolve(__dirname, '../../packages/store/src/index.ts'),
      '@aggregaytor/adapter-sniffies': resolve(__dirname, '../../adapters/sniffies/src/index.ts'),
      '@aggregaytor/adapter-grindr': resolve(__dirname, '../../adapters/grindr/src/index.ts'),
      '@aggregaytor/adapter-doublelist': resolve(__dirname, '../../adapters/doublelist/src/index.ts'),
      '@aggregaytor/adapter-adam4adam': resolve(__dirname, '../../adapters/adam4adam/src/index.ts'),
      '@aggregaytor/adapter-gmail': resolve(__dirname, '../../adapters/gmail/src/index.ts'),
      '@aggregaytor/adapter-yahoo': resolve(__dirname, '../../adapters/yahoo/src/index.ts'),
    },
  },
  ssr: {
    noExternal: ['events'],
  },
  optimizeDeps: {
    include: ['events', 'pouchdb-browser', 'pouchdb-find'],
  },
});
