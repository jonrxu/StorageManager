'use strict';

const fs = require('fs/promises');
const path = require('path');

const MB = 1e6;
const GB = 1e9;
const DAY = 864e5;

/**
 * Rule-based cleanup recommendations, computed from a finished Scanner.
 * Each recommendation: { id, title, description, risk: 'safe'|'caution',
 *   bytes, items: [{path, bytes, note?}], hint?, actionable, special? }
 */
async function buildRecommendations(scanner) {
  const recs = [];
  const home = scanner.home;
  const cum = scanner.cumBytes || new Map();
  const kids = scanner.childIndex || new Map();
  const abs = (rel) => path.join(home, rel);
  const sizeOf = (rel) => cum.get(abs(rel)) || 0;
  const topChildren = (rel, n) => (kids.get(abs(rel)) || []).slice(0, n);

  // 1. App caches and logs — the classic safe win.
  {
    const items = [];
    for (const child of topChildren('Library/Caches', 12)) {
      if (child.bytes > 10 * MB) items.push({ path: child.path, bytes: child.bytes });
    }
    const logs = sizeOf('Library/Logs');
    if (logs > 10 * MB) items.push({ path: abs('Library/Logs'), bytes: logs, note: 'app logs' });
    const dotCache = sizeOf('.cache');
    if (dotCache > 10 * MB) items.push({ path: abs('.cache'), bytes: dotCache, note: 'tool caches' });
    push(recs, {
      id: 'caches',
      risk: 'safe',
      title: 'Clear app caches & logs',
      description: 'Temporary files apps rebuild automatically. Some apps may open slightly slower once while caches are recreated.',
      items,
    });
  }

  // 2. Package manager caches (everything here is re-downloaded on demand).
  {
    const candidates = [
      ['.npm', 'npm cache'],
      ['.yarn/cache', 'Yarn cache'],
      ['.pnpm-store', 'pnpm store'],
      ['Library/pnpm', 'pnpm store'],
      ['.cargo/registry', 'Rust crates'],
      ['.cargo/git', 'Rust git deps'],
      ['.gradle/caches', 'Gradle cache'],
      ['.m2/repository', 'Maven repository'],
      ['.cocoapods', 'CocoaPods specs'],
      ['go/pkg/mod', 'Go modules'],
      ['.gem', 'Ruby gems cache'],
    ];
    const items = [];
    for (const [rel, note] of candidates) {
      const b = sizeOf(rel);
      if (b > 25 * MB) items.push({ path: abs(rel), bytes: b, note });
    }
    push(recs, {
      id: 'pkg-caches',
      risk: 'safe',
      title: 'Clear package manager caches',
      description: 'npm, cargo, Gradle and friends re-download anything they need, so these caches are safe to remove.',
      items,
    });
  }

  // 3. Xcode build junk.
  {
    const items = [];
    const dd = sizeOf('Library/Developer/Xcode/DerivedData');
    if (dd > 25 * MB) items.push({ path: abs('Library/Developer/Xcode/DerivedData'), bytes: dd, note: 'build intermediates' });
    const simCaches = sizeOf('Library/Developer/CoreSimulator/Caches');
    if (simCaches > 25 * MB) items.push({ path: abs('Library/Developer/CoreSimulator/Caches'), bytes: simCaches, note: 'simulator caches' });
    push(recs, {
      id: 'xcode-build',
      risk: 'safe',
      title: 'Clear Xcode build files',
      description: 'DerivedData is rebuilt on the next compile. Removing it just makes the next build slower.',
      items,
    });
  }

  // 4. Mail attachment cache.
  {
    const b = sizeOf('Library/Containers/com.apple.mail/Data/Library/Mail Downloads');
    push(recs, {
      id: 'mail-downloads',
      risk: 'safe',
      title: 'Clear Mail attachment previews',
      description: 'Copies of attachments you opened in Mail. The originals stay in your mailbox.',
      items: b > 50 * MB ? [{ path: abs('Library/Containers/com.apple.mail/Data/Library/Mail Downloads'), bytes: b }] : [],
    });
  }

  // 5. Trash itself.
  {
    const b = sizeOf('.Trash');
    if (b > 10 * MB) {
      recs.push({
        id: 'trash',
        risk: 'safe',
        title: 'Empty the Trash',
        description: 'Files in the Trash still occupy disk space until you empty it.',
        bytes: b,
        items: [{ path: abs('.Trash'), bytes: b, note: 'use the Empty Trash button' }],
        actionable: false,
        special: 'emptyTrash',
      });
    }
  }

  // 6. Stale node_modules folders.
  {
    const items = [];
    for (const [d, bytes] of cum) {
      if (!d.endsWith(path.sep + 'node_modules')) continue;
      if (d.slice(0, -'/node_modules'.length).includes(path.sep + 'node_modules' + path.sep)) continue; // nested
      if (bytes > 25 * MB) items.push({ path: d, bytes });
    }
    items.sort((a, b) => b.bytes - a.bytes);
    push(recs, {
      id: 'node-modules',
      risk: 'caution',
      title: 'Remove node_modules from old projects',
      description: 'Each folder is recreated by `npm install` (or yarn/pnpm) the next time you work on that project.',
      items: items.slice(0, 15),
      hint: 'Only remove these for projects you are not actively working on.',
    });
  }

  // 7. Xcode simulators & device support (bigger, but more annoying to recreate).
  {
    const items = [];
    const candidates = [
      ['Library/Developer/Xcode/iOS DeviceSupport', 'debug symbols per iOS version'],
      ['Library/Developer/Xcode/watchOS DeviceSupport', 'watchOS debug symbols'],
      ['Library/Developer/Xcode/Archives', 'app archives (needed for past releases)'],
      ['Library/Developer/CoreSimulator/Devices', 'simulator disk images'],
    ];
    for (const [rel, note] of candidates) {
      const b = sizeOf(rel);
      if (b > 100 * MB) items.push({ path: abs(rel), bytes: b, note });
    }
    push(recs, {
      id: 'xcode-heavy',
      risk: 'caution',
      title: 'Review Xcode simulators & device support',
      description: 'Re-downloaded or rebuilt when needed, but that can take a while. Archives are needed to symbolicate shipped builds.',
      items,
      hint: 'Tip: `xcrun simctl delete unavailable` removes outdated simulators safely.',
    });
  }

  // 8. Old files in Downloads.
  {
    const items = [];
    try {
      const dlDir = abs('Downloads');
      const entries = await fs.readdir(dlDir, { withFileTypes: true });
      const now = Date.now();
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const full = path.join(dlDir, ent.name);
        try {
          const st = await fs.lstat(full);
          const bytes = ent.isDirectory() ? cum.get(full) || 0 : (st.blocks || 0) * 512;
          const ageDays = Math.floor((now - st.mtimeMs) / DAY);
          if (ageDays > 90 && bytes > 10 * MB) {
            items.push({ path: full, bytes, note: `untouched for ${fmtAge(ageDays)}` });
          }
        } catch {}
      }
    } catch {}
    items.sort((a, b) => b.bytes - a.bytes);
    push(recs, {
      id: 'old-downloads',
      risk: 'caution',
      title: 'Old items in Downloads',
      description: 'Installers and files you have not touched in over 3 months. Usually forgotten, occasionally important.',
      items: items.slice(0, 20),
    });
  }

  // 9. iPhone / iPad backups.
  {
    const items = topChildren('Library/Application Support/MobileSync/Backup', 8)
      .filter((c) => c.bytes > 100 * MB)
      .map((c) => ({ path: c.path, bytes: c.bytes, note: 'one device backup' }));
    push(recs, {
      id: 'ios-backups',
      risk: 'caution',
      title: 'Old iPhone / iPad backups',
      description: 'Each folder is a full device backup made by Finder. Keep the most recent backup for devices you still own.',
      items,
    });
  }

  // 10. Big files untouched for 6+ months.
  {
    const now = Date.now();
    const items = (scanner.largeFiles || [])
      .filter((f) => f.bytes > 1 * GB && now - f.mtime > 180 * DAY)
      .slice(0, 15)
      .map((f) => ({ path: f.path, bytes: f.bytes, note: `untouched for ${fmtAge(Math.floor((now - f.mtime) / DAY))}` }));
    push(recs, {
      id: 'large-old',
      risk: 'caution',
      title: 'Huge files you have not touched in 6+ months',
      description: 'Disk images, videos, archives and exports tend to pile up here. Review each one before deleting.',
      items,
    });
  }

  // 11. Recently added space hogs (the "what just filled my disk?" list).
  {
    const now = Date.now();
    const items = (scanner.recentFiles || [])
      .slice(0, 15)
      .map((f) => ({ path: f.path, bytes: f.bytes, note: `added ${fmtAge(Math.max(0, Math.floor((now - f.birthtime) / DAY)))} ago` }));
    push(recs, {
      id: 'recent-large',
      risk: 'caution',
      title: 'Large files added in the last 30 days',
      description: 'If your disk filled up recently, the culprit is probably in this list.',
      items,
      minBytes: 50 * MB,
    });
  }

  // 12. Docker (informational — pruning from Docker itself is safer).
  {
    const b = sizeOf('Library/Containers/com.docker.docker');
    if (b > 2 * GB) {
      recs.push({
        id: 'docker',
        risk: 'caution',
        title: 'Docker is using a lot of space',
        description: 'Docker stores all images, containers and volumes in one big file. Do not trash it directly while Docker is installed.',
        bytes: b,
        items: [{ path: abs('Library/Containers/com.docker.docker'), bytes: b, note: 'managed by Docker' }],
        actionable: false,
        hint: 'Run `docker system prune -a` in a terminal to reclaim space safely.',
      });
    }
  }

  recs.sort((a, b) => (a.risk === b.risk ? b.bytes - a.bytes : a.risk === 'safe' ? -1 : 1));
  return recs;
}

function push(recs, rec) {
  const minBytes = rec.minBytes || 25 * MB;
  delete rec.minBytes;
  rec.items = (rec.items || []).filter((i) => i.bytes > 0);
  rec.bytes = rec.items.reduce((s, i) => s + i.bytes, 0);
  if (rec.actionable === undefined) rec.actionable = true;
  if (rec.items.length && rec.bytes >= minBytes) recs.push(rec);
}

function fmtAge(days) {
  if (days >= 365) return `${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}mo`;
  if (days >= 60) return `${Math.floor(days / 30)} months`;
  if (days >= 30) return `1 month`;
  return `${days} days`;
}

module.exports = { buildRecommendations };
