'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { CATEGORIES, categorize } = require('./categories');

const LARGE_FILE_FLOOR = 50e6; // only track files >= 50 MB as "large"
const RECENT_FILE_FLOOR = 5e6; // only track recent files >= 5 MB
const RECENT_WINDOW_MS = 30 * 864e5; // "recently added" = last 30 days
const KEEP_LARGE = 250;
const KEEP_RECENT = 250;

// Only relevant when scanning outside the home folder; avoids firmlink loops
// and other volumes when someone points the scanner at '/'.
const ABSOLUTE_SKIP = new Set(['/System', '/Volumes', '/private', '/dev', '/Network', '/cores']);
const NAME_SKIP = new Set(['.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100', '.TemporaryItems', '.Trashes', '.PreviousSystemInformation']);

class Scanner {
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.home = os.homedir();
    this.concurrency = opts.concurrency || 48;
    this.cancelled = false;

    this.dirBytes = new Map(); // dir -> bytes of files directly inside it
    this.cumBytes = null; // dir -> cumulative bytes (after finalize)
    this.childIndex = null; // dir -> [{path, bytes}] sorted desc (after finalize)
    this.catTotals = new Map(CATEGORIES.map((c) => [c.id, { bytes: 0, count: 0 }]));

    this.largeFiles = [];
    this.largeFloor = LARGE_FILE_FLOOR;
    this.recentFiles = [];
    this.recentFloor = RECENT_FILE_FLOOR;
    this.recentCutoff = Date.now() - RECENT_WINDOW_MS;

    this.filesScanned = 0;
    this.dirsScanned = 0;
    this.bytesFound = 0;
    this.errorCount = 0;
    this.permissionErrors = 0;
    this.errorSamples = [];
    this.currentPath = '';
    this.startedAt = null;
    this.finishedAt = null;
    this.rootDev = null;
    this.pending = [];
    this.pump = null;
  }

  relToHome(p) {
    if (p === this.home) return '';
    if (p.startsWith(this.home + path.sep)) return p.slice(this.home.length + 1);
    return null;
  }

  categorizePath(p, isDir) {
    const rel = this.relToHome(p);
    if (rel === null || rel === '') return 'other';
    return categorize(isDir ? rel + '/' : rel);
  }

  noteError(p, err) {
    if (err && err.code === 'ENOENT') return; // file vanished mid-scan, not interesting
    this.errorCount++;
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) this.permissionErrors++;
    if (this.errorSamples.length < 20) this.errorSamples.push({ path: p, code: (err && err.code) || 'ERR' });
  }

  cancel() {
    this.cancelled = true;
    if (this.pump) this.pump();
  }

  async run() {
    const rootStat = await fs.lstat(this.root);
    this.rootDev = rootStat.dev;
    this.startedAt = Date.now();
    this.pending = [this.root];

    await new Promise((resolve) => {
      let active = 0;
      const pump = () => {
        if (this.cancelled) this.pending.length = 0;
        while (active < this.concurrency && this.pending.length) {
          const dir = this.pending.pop();
          active++;
          this.processDir(dir)
            .catch((e) => this.noteError(dir, e))
            .finally(() => {
              active--;
              pump();
            });
        }
        if (active === 0 && this.pending.length === 0) resolve();
      };
      this.pump = pump;
      pump();
    });

    this.finishedAt = Date.now();
    if (!this.cancelled) this.finalize();
    return this.result();
  }

  async processDir(dir) {
    this.currentPath = dir;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      this.noteError(dir, e);
      return;
    }
    this.dirsScanned++;
    if (!this.dirBytes.has(dir)) this.dirBytes.set(dir, 0);

    const tasks = [];
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (NAME_SKIP.has(ent.name) && dir !== this.home) continue;
        if (ABSOLUTE_SKIP.has(full)) continue;
        tasks.push(this.queueDir(full));
      } else if (ent.isFile()) {
        tasks.push(this.statFile(full, dir));
      }
    }
    await Promise.all(tasks);
  }

  async queueDir(full) {
    try {
      const st = await fs.lstat(full);
      if (st.dev !== this.rootDev) return; // don't cross onto other volumes
    } catch (e) {
      this.noteError(full, e);
      return;
    }
    if (this.cancelled) return;
    this.pending.push(full);
    this.pump();
  }

  async statFile(full, parentDir) {
    let st;
    try {
      st = await fs.lstat(full);
    } catch (e) {
      this.noteError(full, e);
      return;
    }
    // Allocated size on disk (handles sparse, compressed and cloud-placeholder files).
    const bytes = (st.blocks || 0) * 512;
    this.filesScanned++;
    this.bytesFound += bytes;
    this.dirBytes.set(parentDir, (this.dirBytes.get(parentDir) || 0) + bytes);

    const cat = this.catTotals.get(this.categorizePath(full, false));
    cat.bytes += bytes;
    cat.count++;

    if (bytes >= this.largeFloor) {
      this.largeFiles.push({ path: full, bytes, mtime: st.mtimeMs, birthtime: st.birthtimeMs });
      if (this.largeFiles.length > KEEP_LARGE * 4) {
        this.largeFiles.sort((a, b) => b.bytes - a.bytes);
        this.largeFiles.length = KEEP_LARGE;
        this.largeFloor = Math.max(this.largeFloor, this.largeFiles[KEEP_LARGE - 1].bytes);
      }
    }
    if (bytes >= this.recentFloor && st.birthtimeMs >= this.recentCutoff) {
      this.recentFiles.push({ path: full, bytes, mtime: st.mtimeMs, birthtime: st.birthtimeMs });
      if (this.recentFiles.length > KEEP_RECENT * 4) {
        this.recentFiles.sort((a, b) => b.bytes - a.bytes);
        this.recentFiles.length = KEEP_RECENT;
        this.recentFloor = Math.max(this.recentFloor, this.recentFiles[KEEP_RECENT - 1].bytes);
      }
    }
  }

  finalize() {
    // Roll file bytes up the directory tree, deepest dirs first.
    const cum = new Map(this.dirBytes);
    const dirs = [...cum.keys()].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
    for (const d of dirs) {
      if (d === this.root) continue;
      const parent = path.dirname(d);
      if (cum.has(parent)) cum.set(parent, cum.get(parent) + cum.get(d));
    }
    this.cumBytes = cum;

    const childIndex = new Map();
    for (const [d, bytes] of cum) {
      if (d === this.root) continue;
      const parent = path.dirname(d);
      let arr = childIndex.get(parent);
      if (!arr) childIndex.set(parent, (arr = []));
      arr.push({ path: d, bytes });
    }
    for (const arr of childIndex.values()) arr.sort((a, b) => b.bytes - a.bytes);
    this.childIndex = childIndex;

    this.largeFiles.sort((a, b) => b.bytes - a.bytes);
    this.largeFiles.length = Math.min(this.largeFiles.length, KEEP_LARGE);
    this.recentFiles.sort((a, b) => b.bytes - a.bytes);
    this.recentFiles.length = Math.min(this.recentFiles.length, KEEP_RECENT);
  }

  /** Top "boundary" dirs per category, e.g. each node_modules root, ~/Library/Caches itself. */
  categoryTopDirs() {
    const tops = new Map(CATEGORIES.map((c) => [c.id, []]));
    for (const [d, bytes] of this.cumBytes) {
      if (d === this.root || bytes < 1e6) continue;
      const cat = this.categorizePath(d, true);
      if (cat === 'other') continue;
      if (this.categorizePath(path.dirname(d), true) === cat) continue; // not the top of its region
      tops.get(cat).push({ path: d, bytes });
    }
    for (const arr of tops.values()) arr.sort((a, b) => b.bytes - a.bytes);
    return tops;
  }

  result() {
    const topDirs = this.cumBytes ? this.categoryTopDirs() : new Map();
    const categories = CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      color: c.color,
      hint: c.hint,
      bytes: this.catTotals.get(c.id).bytes,
      count: this.catTotals.get(c.id).count,
      topDirs: (topDirs.get(c.id) || []).slice(0, 10),
    }))
      .filter((c) => c.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);

    return {
      root: this.root,
      home: this.home,
      scannedAt: Date.now(),
      durationMs: (this.finishedAt || Date.now()) - (this.startedAt || Date.now()),
      totalBytes: this.bytesFound,
      filesScanned: this.filesScanned,
      dirsScanned: this.dirsScanned,
      errors: { count: this.errorCount, permission: this.permissionErrors, samples: this.errorSamples.slice(0, 15) },
      categories,
      largeFiles: this.largeFiles,
      recentFiles: this.recentFiles,
    };
  }
}

module.exports = { Scanner };
