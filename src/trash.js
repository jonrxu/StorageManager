'use strict';

const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// Never allow deleting the home folder itself or whole standard folders.
const PROTECTED = new Set(
  ['', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Applications', 'Public', '.Trash'].map((p) =>
    path.join(HOME, p)
  )
);

function validateTrashable(p) {
  const abs = path.resolve(String(p));
  if (abs !== HOME && !abs.startsWith(HOME + path.sep)) {
    throw new Error('Refusing to touch anything outside your home folder');
  }
  if (PROTECTED.has(abs)) {
    throw new Error('Refusing to delete a protected folder');
  }
  return abs;
}

function escapeAs(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || 'osascript failed').trim()));
      else resolve(String(stdout).trim());
    });
  });
}

async function finderDelete(paths) {
  const list = paths.map((p) => `POSIX file "${escapeAs(p)}"`).join(', ');
  await runOsascript(`tell application "Finder" to delete {${list}}`);
}

/** Fallback when Finder automation is denied: move into ~/.Trash manually. */
async function manualTrash(p) {
  const trashDir = path.join(HOME, '.Trash');
  await fs.mkdir(trashDir, { recursive: true });
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  let target = path.join(trashDir, path.basename(p));
  for (let i = 2; ; i++) {
    try {
      await fs.lstat(target);
      target = path.join(trashDir, `${stem} ${i}${ext}`);
    } catch {
      break;
    }
  }
  await fs.rename(p, target);
}

/**
 * Move paths to the Trash (recoverable). Returns per-path results.
 * Tries Finder first (proper "Put Back" support), falls back to a manual move.
 */
async function moveToTrash(rawPaths) {
  const results = [];
  const valid = [];
  for (const p of rawPaths) {
    try {
      const abs = validateTrashable(p);
      await fs.lstat(abs); // must exist
      valid.push(abs);
    } catch (e) {
      results.push({ path: String(p), ok: false, error: e.message });
    }
  }

  for (let i = 0; i < valid.length; i += 20) {
    const chunk = valid.slice(i, i + 20);
    try {
      await finderDelete(chunk);
      for (const p of chunk) results.push({ path: p, ok: true, method: 'finder' });
    } catch {
      // Retry one-by-one so a single bad path doesn't sink the batch.
      for (const p of chunk) {
        try {
          await finderDelete([p]);
          results.push({ path: p, ok: true, method: 'finder' });
        } catch {
          try {
            await manualTrash(p);
            results.push({ path: p, ok: true, method: 'move' });
          } catch (e) {
            results.push({ path: p, ok: false, error: e.message });
          }
        }
      }
    }
  }
  return results;
}

async function emptyTrash() {
  await runOsascript('tell application "Finder" to empty trash');
}

module.exports = { moveToTrash, emptyTrash, validateTrashable };
