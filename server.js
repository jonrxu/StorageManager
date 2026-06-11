'use strict';

// More libuv threads = faster parallel stat() calls during scans.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '32';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { execFile } = require('child_process');

const { Scanner } = require('./src/scanner');
const { buildRecommendations } = require('./src/recommend');
const { rankApplications } = require('./src/apps');
const { moveToTrash, emptyTrash, validateTrashable } = require('./src/trash');
const settings = require('./src/settings');
const { analyze } = require('./src/llm');

const PORT = Number(process.env.PORT || 4823);
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- scan state
let scanState = { state: 'idle' }; // idle | running | done | error
let scanner = null;
let result = null; // finished scan result + recommendations

// ---------------------------------------------------------------------- disk
function diskInfo() {
  return new Promise((resolve, reject) => {
    const target = '/System/Volumes/Data';
    execFile('/bin/df', ['-k', target], (err, stdout) => {
      const parse = (out) => {
        const line = out.trim().split('\n').pop();
        const cols = line.trim().split(/\s+/);
        const totalBytes = Number(cols[1]) * 1024;
        const freeBytes = Number(cols[3]) * 1024;
        return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
      };
      if (!err) return resolve(parse(stdout));
      execFile('/bin/df', ['-k', '/'], (err2, stdout2) => {
        if (err2) return reject(err2);
        resolve(parse(stdout2));
      });
    });
  });
}

app.get('/api/disk', async (req, res) => {
  try {
    res.json(await diskInfo());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------- scan
// System areas included in a whole-Mac scan, alongside the home folder.
// (/System and the sealed system volume are skipped: read-only and not cleanable.)
const SYSTEM_ROOTS = ['/Applications', '/Library', '/opt', '/usr/local', '/private/var'];

app.post('/api/scan', async (req, res) => {
  if (scanState.state === 'running') return res.status(409).json({ error: 'A scan is already running.' });

  const body = req.body || {};
  let p = body.path ? String(body.path).trim() : '';
  if (p === '~') p = os.homedir();
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));

  let mode, roots;
  if (body.mode === 'machine' || !p || path.resolve(p) === '/') {
    mode = 'machine';
    roots = [os.homedir(), ...SYSTEM_ROOTS];
  } else {
    mode = 'folder';
    roots = [path.resolve(p)];
  }

  const validRoots = [];
  for (const r of roots) {
    try {
      if ((await fs.stat(r)).isDirectory()) validRoots.push(r);
    } catch {}
  }
  if (!validRoots.length) return res.status(400).json({ error: `Folder not found: ${roots[0]}` });

  scanner = new Scanner(validRoots);
  result = null;
  scanState = { state: 'running', startedAt: Date.now(), mode };

  scanner
    .run()
    .then(async (scanResult) => {
      if (scanner.cancelled) {
        scanState = { state: 'idle' };
        return;
      }
      let recommendations = [];
      let apps = [];
      try {
        apps = await rankApplications(scanner);
      } catch (e) {
        console.error('Failed to rank applications:', e);
      }
      try {
        recommendations = await buildRecommendations(scanner, apps);
      } catch (e) {
        console.error('Failed to build recommendations:', e);
      }
      result = { ...scanResult, recommendations, apps, mode };
      scanState = { state: 'done' };
    })
    .catch((e) => {
      scanState = { state: 'error', error: e.message };
    });

  res.json({ ok: true, roots: validRoots, mode });
});

app.get('/api/scan/status', (req, res) => {
  const out = { state: scanState.state };
  if (scanState.error) out.error = scanState.error;
  if (scanState.state === 'running' && scanner) {
    out.progress = {
      files: scanner.filesScanned,
      dirs: scanner.dirsScanned,
      bytes: scanner.bytesFound,
      errors: scanner.errorCount,
      currentPath: scanner.currentPath,
      elapsedMs: Date.now() - scanState.startedAt,
    };
  }
  if (scanState.state === 'done') out.result = result;
  res.json(out);
});

app.post('/api/scan/cancel', (req, res) => {
  if (scanner) scanner.cancel();
  res.json({ ok: true });
});

// ------------------------------------------------------------ folder browser
app.get('/api/dir', async (req, res) => {
  try {
    if (!scanner || !scanner.cumBytes) return res.status(400).json({ error: 'Run a scan first.' });
    const p = path.resolve(String(req.query.path || scanner.roots[0]));
    const owner = scanner.roots.find((r) => p === r || p.startsWith(r + path.sep));
    if (!owner) {
      return res.status(400).json({ error: 'Path is outside the scanned locations.' });
    }
    const entries = await fs.readdir(p, { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) {
        out.push({ name: ent.name, path: full, isDir: true, bytes: scanner.cumBytes.get(full) || 0 });
      } else if (ent.isFile()) {
        try {
          const st = await fs.lstat(full);
          out.push({ name: ent.name, path: full, isDir: false, bytes: (st.blocks || 0) * 512, mtime: st.mtimeMs });
        } catch {}
      }
    }
    out.sort((a, b) => b.bytes - a.bytes);
    res.json({ path: p, root: owner, totalBytes: scanner.cumBytes.get(p) || 0, entries: out.slice(0, 400) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------------------- trash
app.post('/api/trash', async (req, res) => {
  try {
    const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths.slice(0, 200) : [];
    if (!paths.length) return res.status(400).json({ error: 'No paths given.' });

    // Estimate reclaimable bytes before the files disappear.
    let freedBytes = 0;
    for (const p of paths) {
      try {
        const abs = validateTrashable(p);
        const cached = scanner && scanner.cumBytes ? scanner.cumBytes.get(abs) : null;
        if (cached) {
          freedBytes += cached;
        } else {
          const st = await fs.lstat(abs);
          freedBytes += st.isDirectory() ? 0 : (st.blocks || 0) * 512;
        }
      } catch {}
    }

    const results = await moveToTrash(paths);
    res.json({ results, freedBytes, okCount: results.filter((r) => r.ok).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trash/empty', async (req, res) => {
  try {
    await emptyTrash();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------------ settings
app.get('/api/settings', async (req, res) => {
  res.json(settings.publicView(await settings.load()));
});

app.post('/api/settings', async (req, res) => {
  try {
    const cfg = await settings.save(req.body || {});
    res.json(settings.publicView(cfg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------------------ AI
function buildAiSummary(disk) {
  const home = scanner.home;
  const tidy = (p) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
  const gb = (b) => Math.round((b / 1e9) * 100) / 100;
  const days = (ms) => Math.max(0, Math.floor((Date.now() - ms) / 864e5));

  // Top folders: category boundaries + anything big in the first few levels.
  const seen = new Set();
  const tops = [];
  const add = (p, bytes) => {
    if (seen.has(p) || scanner.rootSet.has(p)) return;
    seen.add(p);
    tops.push({ path: tidy(p), gb: gb(bytes) });
  };
  for (const cat of result.categories) for (const d of cat.topDirs.slice(0, 4)) add(d.path, d.bytes);
  for (const [d, bytes] of scanner.cumBytes) {
    if (bytes <= 500e6 || scanner.rootSet.has(d)) continue;
    const owner = scanner.roots.find((r) => d.startsWith(r + path.sep));
    if (!owner) continue;
    if (d.slice(owner.length + 1).split(path.sep).length > 3) continue;
    add(d, bytes);
  }
  tops.sort((a, b) => b.gb - a.gb);

  const days2 = (ms) => (ms ? days(ms) : null);
  return {
    disk: { totalGb: gb(disk.totalBytes), freeGb: gb(disk.freeBytes) },
    scan: { roots: scanner.roots.map(tidy), totalGb: gb(result.totalBytes), files: result.filesScanned },
    categories: result.categories.map((c) => ({ name: c.label, gb: gb(c.bytes) })),
    topFolders: tops.slice(0, 45),
    applications: (result.apps || []).slice(0, 15).map((a) => ({ name: a.name, gb: gb(a.bytes), lastUsedDaysAgo: days2(a.lastUsedMs) })),
    largeFiles: result.largeFiles.slice(0, 30).map((f) => ({
      path: tidy(f.path),
      gb: gb(f.bytes),
      modifiedDaysAgo: days(f.mtime),
      addedDaysAgo: days(f.birthtime),
    })),
    recentLargeFiles: result.recentFiles.slice(0, 15).map((f) => ({ path: tidy(f.path), gb: gb(f.bytes), addedDaysAgo: days(f.birthtime) })),
    appFindings: result.recommendations.map((r) => ({ title: r.title, gb: gb(r.bytes), risk: r.risk })),
  };
}

async function enrichAiRecommendations(recs) {
  const home = scanner.home;
  const out = [];
  for (const rec of recs.slice(0, 10)) {
    const items = [];
    const rawPaths = Array.isArray(rec.paths) ? rec.paths.slice(0, 20) : [];
    for (let p of rawPaths) {
      if (typeof p !== 'string' || !p.trim()) continue;
      p = p.trim();
      if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
      const abs = path.resolve(p);
      const within = scanner.roots.some((r) => abs === r || abs.startsWith(r + path.sep));
      if (!within) continue;
      try {
        const st = await fs.lstat(abs);
        const bytes = scanner.cumBytes.get(abs) || (st.isDirectory() ? 0 : (st.blocks || 0) * 512);
        let trashable = true;
        try {
          validateTrashable(abs);
        } catch {
          trashable = false;
        }
        items.push({ path: abs, bytes, exists: true, trashable });
      } catch {
        items.push({ path: abs, bytes: 0, exists: false, trashable: false });
      }
    }
    out.push({
      title: String(rec.title || 'Suggestion'),
      why: String(rec.why || ''),
      how: String(rec.how || ''),
      risk: ['safe', 'caution', 'risky'].includes(rec.risk) ? rec.risk : 'caution',
      estimatedBytes: Number(rec.estimatedBytes) || 0,
      verifiedBytes: items.reduce((s, i) => s + i.bytes, 0),
      items,
    });
  }
  return out;
}

app.post('/api/ai/analyze', async (req, res) => {
  try {
    if (!result || !scanner) return res.status(400).json({ error: 'Run a scan first.' });
    const cfg = await settings.load();
    if (!cfg.apiKey) return res.status(400).json({ error: 'no-key' });

    const disk = await diskInfo().catch(() => ({ totalBytes: 0, freeBytes: 0 }));
    const summary = buildAiSummary(disk);
    const analysis = await analyze({ provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, summary });
    analysis.recommendations = await enrichAiRecommendations(analysis.recommendations);
    res.json(analysis);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --------------------------------------------------------------------- start
app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Storage Manager running at ${url}`);
  console.log('  Everything stays on this Mac. Press Ctrl+C to quit.\n');
  if (!process.argv.includes('--no-open')) execFile('/usr/bin/open', [url], () => {});
});
