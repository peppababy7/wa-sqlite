// Copyright 2024 Roy T. Hashimoto. All Rights Reserved.

import * as SQLite from '../src/sqlite-api.js';

const BUILDS = new Map([
  ['default', '../dist/wa-sqlite.mjs'],
  ['asyncify', '../dist/wa-sqlite-async.mjs'],
  ['jspi', '../dist/wa-sqlite-jspi.mjs'],
]);

const MODULE = Symbol('module');

/**
 * @typedef Config
 * @property {string} name
 * @property {string} vfsModule path of the VFS module
 * @property {string} [vfsClass] name of the VFS class
 * @property {Array<*>} [vfsArgs] VFS constructor arguments
 */

/** @type {Map<string, Config>} */ const VFS_CONFIGS = new Map([
  {
    name: 'default',
    vfsModule: null
  },
  {
    name: 'MemoryVFS',
    vfsModule: '../src/examples/MemoryVFS.js',
  },
  {
    name: 'MemoryAsyncVFS',
    vfsModule: '../src/examples/MemoryAsyncVFS.js',
  },
  {
    name: 'IDBBatchAtomicVFS',
    vfsModule: '../src/examples/IDBBatchAtomicVFS.js',
  },
  {
    name: 'OriginPrivateVFS',
    vfsModule: '../src/examples/OriginPrivateVFS.js',
  },
  {
    name: 'AccessHandlePoolVFS',
    vfsModule: '../src/examples/AccessHandlePoolVFS.js',
  },
  {
    name: 'FLOOR',
    vfsModule: '../src/examples/FLOOR.js',
  },
].map(config => [config.name, config]));

const searchParams = new URLSearchParams(location.search);

maybeReset().then(async () => {
  const buildName = searchParams.get('build') || BUILDS.keys().next().value;
  const configName = searchParams.get('config') || VFS_CONFIGS.keys().next().value;
  const config = VFS_CONFIGS.get(configName);
  const dbName = searchParams.get('db') ?? 'hello';

  if (config.name === 'AccessHandlePoolVFS') {
    // Special setup for AccessHandlePoolVFS. The database and journal
    // files must be created before instantiating the VFS if they are
    // to be persistent.
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('demo', { create: true });
    await dir.getFileHandle(dbName, { create: true });
    await dir.getFileHandle(`${dbName}-journal`, { create: true });
  }

  // Instantiate SQLite.
  const { default: moduleFactory } = await import(BUILDS.get(buildName));
  const module = await moduleFactory();
  const sqlite3 = SQLite.Factory(module);

  if (config.vfsModule) {
    // Create the VFS and register it as the default file system.
    const namespace = await import(config.vfsModule);
    const className = config.vfsClass ?? config.vfsModule.match(/([^/]+)\.js$/)[1];
    const vfsArgs = (config.vfsArgs ?? ['demo', MODULE])
      .map(arg => arg === MODULE ? module : arg);
    const vfs = await namespace[className].create(...vfsArgs);
    sqlite3.vfs_register(vfs, true);
  }

  // Open the database.
  const db = await sqlite3.open_v2(dbName);

  // Handle SQL queries.
  addEventListener('message', async (event) => {
    try {
      const query = event.data;

      const start = performance.now();
      const results = [];
      for await (const stmt of sqlite3.statements(db, query)) {
        const rows = [];
        while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
          const row = sqlite3.row(stmt);
          rows.push(row);
        }
  
        const columns = sqlite3.column_names(stmt)
        if (columns.length) {
          results.push({ columns, rows });
        }
      }
      const end = performance.now();

      postMessage({
        results,
        elapsed: Math.trunc(end - start) / 1000
      })
    } catch (e) {
      console.error(e);
      postMessage({ error: cvtErrorToCloneable(e) });
    }
  });

  // Signal that we're ready.
  postMessage(null);
}).catch(e => {
  console.error(e);
  postMessage({ error: cvtErrorToCloneable(e) });
});

async function maybeReset() {
  if (searchParams.has('reset')) {
    const outerLockReleaser = await new Promise(resolve => {
      navigator.locks.request('demo-worker-outer', lock => {
        return new Promise(release => {
          resolve(release);
        });
      });
    });

    await navigator.locks.request('demo-worker-inner', { ifAvailable: true }, async lock => {
      if (lock) {
        console.log('clearing OPFS and IndexedDB');
        const root = await navigator.storage?.getDirectory();
        if (root) {
          // @ts-ignore
          for await (const name of root.keys()) {
            await root.removeEntry(name, { recursive: true });
          }
        }
    
        // Clear IndexedDB.
        const dbList = indexedDB.databases ?
          await indexedDB.databases() :
          ['demo', 'demo-floor'].map(name => ({ name }));
        await Promise.all(dbList.map(({name}) => {
          return new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = resolve;
            request.onerror = reject;
          });
        }));
      } else {
        console.warn('reset skipped because another instance already holds the lock');
      }
    });
    
    await new Promise((resolve, reject) => {
      const mode = searchParams.has('exclusive') ? 'exclusive' : 'shared';
      navigator.locks.request('demo-worker-inner', { mode, ifAvailable: true }, lock => {
        if (lock) {
          resolve();
          return new Promise(() => {});
        } else {
          reject(new Error('failed to acquire inner lock'));
        }
      });
    });

    outerLockReleaser();
  }
}

function cvtErrorToCloneable(e) {
  if (e instanceof Error) {
    const props = new Set([
      ...['name', 'message', 'stack'].filter(k => e[k] !== undefined),
      ...Object.getOwnPropertyNames(e)
    ]);
    return Object.fromEntries(Array.from(props, k =>  [k, e[k]])
      .filter(([_, v]) => {
        // Skip any non-cloneable properties.
        try {
          structuredClone(v);
          return true;
        } catch (e) {
          return false;
        }
      }));
  }
  return e;
}