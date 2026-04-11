import { defineConfig, type Plugin, build as viteBuild } from 'vite';
import { resolve } from 'path';
import { copyFileSync, cpSync, mkdirSync, existsSync, writeFileSync } from 'fs';

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
            },
          },
          logLevel: 'warn',
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [copyExtensionAssets(), buildContentScriptsIIFE()],
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
    },
  },
  ssr: {
    noExternal: ['events'],
  },
  optimizeDeps: {
    include: ['events', 'pouchdb-browser', 'pouchdb-find'],
  },
});
