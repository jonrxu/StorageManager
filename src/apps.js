'use strict';

const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

/** Ask Spotlight when an app was last opened. Returns epoch ms or null. */
function spotlightLastUsed(appPath) {
  return new Promise((resolve) => {
    execFile('/usr/bin/mdls', ['-name', 'kMDItemLastUsedDate', '-raw', appPath], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const s = String(stdout).trim();
      if (!s || s === '(null)') return resolve(null);
      // mdls prints e.g. "2026-05-01 12:34:56 +0000"
      const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/);
      const t = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}`) : Date.parse(s);
      resolve(Number.isFinite(t) ? t : null);
    });
  });
}

/**
 * Fallback when Spotlight has no data (its index pauses on nearly-full disks):
 * the access time of the app's main executable, which updates on launch.
 * Approximate — auto-updates also touch it — so callers mark it as "~".
 */
async function atimeLastUsed(appPath) {
  try {
    const macosDir = path.join(appPath, 'Contents', 'MacOS');
    const entries = await fs.readdir(macosDir);
    if (!entries.length) return null;
    const st = await fs.lstat(path.join(macosDir, entries[0]));
    return st.atimeMs || null;
  } catch {
    return null;
  }
}

/**
 * Rank installed .app bundles by scanned size and attach last-used info:
 * { path, name, bytes, lastUsedMs|null, lastUsedSource: 'spotlight'|'atime'|null }.
 * Covers /Applications (incl. Utilities) and ~/Applications.
 */
async function rankApplications(scanner) {
  if (!scanner.childIndex) return [];
  const containers = ['/Applications', '/Applications/Utilities', path.join(scanner.home, 'Applications')];
  const found = [];
  for (const c of containers) {
    for (const child of scanner.childIndex.get(c) || []) {
      if (child.path.endsWith('.app')) {
        found.push({ path: child.path, name: path.basename(child.path, '.app'), bytes: child.bytes });
      }
    }
  }
  found.sort((a, b) => b.bytes - a.bytes);
  const top = found.slice(0, 40);

  let i = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (i < top.length) {
        const app = top[i++];
        const viaSpotlight = await spotlightLastUsed(app.path);
        if (viaSpotlight) {
          app.lastUsedMs = viaSpotlight;
          app.lastUsedSource = 'spotlight';
        } else {
          app.lastUsedMs = await atimeLastUsed(app.path);
          app.lastUsedSource = app.lastUsedMs ? 'atime' : null;
        }
      }
    })
  );
  return top;
}

module.exports = { rankApplications };
