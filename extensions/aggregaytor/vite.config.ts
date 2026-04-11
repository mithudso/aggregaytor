import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, cpSync, mkdirSync, existsSync } from 'fs';

/**
 * Plugin that copies static extension assets into dist/ after build.
 */
function copyExtensionAssets(): Plugin {
  return {
    name: 'copy-extension-assets',
    writeBundle() {
      const src = resolve(__dirname);
      const dist = resolve(__dirname, 'dist');

      // Copy manifest
      copyFileSync(resolve(src, 'manifest.json'), resolve(dist, 'manifest.json'));

      // Copy static dirs
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

export default defineConfig({
  plugins: [copyExtensionAssets()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: {
        'background/service-worker': resolve(__dirname, 'background/service-worker.ts'),
        'content/sniffies': resolve(__dirname, 'content/sniffies.ts'),
        'content/sniffies-bridge': resolve(__dirname, 'content/sniffies-bridge.ts'),
        'content/sniffies-migrate': resolve(__dirname, 'content/sniffies-migrate.ts'),
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
      // Polyfill Node.js 'events' module for PouchDB in the service worker
      events: 'events',
      '@aggregaytor/context-engine': resolve(__dirname, '../../packages/context-engine/src/index.ts'),
      '@aggregaytor/adapter-core': resolve(__dirname, '../../packages/adapter-core/src/index.ts'),
      '@aggregaytor/store': resolve(__dirname, '../../packages/store/src/index.ts'),
      '@aggregaytor/adapter-sniffies': resolve(__dirname, '../../adapters/sniffies/src/index.ts'),
    },
  },
  // Don't externalize 'events' — PouchDB needs it
  ssr: {
    noExternal: ['events'],
  },
  optimizeDeps: {
    include: ['events', 'pouchdb-browser', 'pouchdb-find'],
  },
});
