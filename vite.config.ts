import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

const STAMP_PLACEHOLDER = '__WN_BUILD_ID__';

/**
 * Puts a value that changes on every build into the service worker.
 *
 * It cannot come from `define`, because everything under `public/` is copied to the build output verbatim
 * and never passes through the transform - a `__APP_VERSION__` in `sw.js` reaches the browser as that
 * literal, and the worker dies on the first cache name it tries to open. So the placeholder is rewritten in
 * the emitted file instead, after the copy has happened.
 *
 * The value is a build timestamp, not `pkg.version`. The cache name exists so that a deploy gets a new
 * cache and `activate` evicts the old generation; a version only moves when somebody remembers to move it,
 * and the case that matters most is a fix to `sw.js` itself - a hotfix that changed this file and not
 * `package.json` produced an identical cache name, so the worker that was supposed to retire the stale
 * generation was itself served out of it, indefinitely. A digest of the asset filenames was considered and
 * rejected for the same reason: a `sw.js`-only fix leaves the filenames identical, so the digest is
 * identical too. Milliseconds since the epoch, base36 - short enough to read in devtools, different on
 * every build by construction, and stable for the whole run so the install and activate phases agree.
 *
 * Both failure directions here are silent, which is why this throws rather than returning:
 *  - placeholder absent from the output means the rename happened and this did not, and shipping would put
 *    a literal `whispernet-__WN_BUILD_ID__` in front of every user, which never changes and never evicts;
 *  - placeholder still present after the rewrite means the substitution did not take, and the same literal
 *    ships for the same reason.
 * A build that cannot stamp the worker is a build that must not be published.
 */
function stampServiceWorker(buildId: string): Plugin {
  return {
    name: 'whispernet-stamp-service-worker',
    apply: 'build',
    closeBundle() {
      const swPath = path.resolve(__dirname, 'dist/client/sw.js');
      if (!existsSync(swPath)) {
        this.error(`stamped worker missing: ${swPath} was not emitted`);
      }
      const source = readFileSync(swPath, 'utf8');
      if (!source.includes(STAMP_PLACEHOLDER)) {
        this.error(
          `${swPath} contains no ${STAMP_PLACEHOLDER}; the service worker's cache name would never change`
        );
      }
      const stamped = source.replaceAll(STAMP_PLACEHOLDER, buildId);
      if (stamped.includes(STAMP_PLACEHOLDER)) {
        this.error(`${STAMP_PLACEHOLDER} survived the rewrite in ${swPath}`);
      }
      writeFileSync(swPath, stamped);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), stampServiceWorker(Date.now().toString(36))],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Without this the whole client is one 574 KB chunk: one edited component invalidates React, the
        // entire Signal implementation and the database layer along with it, so every deploy re-downloads
        // the lot and the offline shell has nothing left to answer with. Split so the vendor and the crypto
        // code - both far larger than the app and both changing on a different schedule - stay cached
        // across ordinary UI edits.
        //
        // Written as a function rather than the object form because that one resolves each key as a module
        // id and errors on one that is not in the graph. `@noble/ciphers` is a declared dependency that
        // nothing imports, so the object form names a module that is not there.
        manualChunks(id) {
          // @noble/* is the biggest thing in the bundle and its contents are keyed by the dependency
          // versions, not by anything in this repository, so it is the most stable chunk there is.
          if (id.includes('node_modules/@noble/')) return 'crypto';
          if (id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react/') ||
              id.includes('node_modules/scheduler/')) return 'vendor';
          return undefined;
        },
      },
    },
  },
});