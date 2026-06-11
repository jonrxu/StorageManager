'use strict';

// Storage categories, ordered for display. Colors are used by the donut chart and legend.
const CATEGORIES = [
  { id: 'documents', label: 'Documents & Desktop', color: '#5b8def', hint: 'Your files in Documents and on the Desktop.' },
  { id: 'media', label: 'Photos & Media', color: '#ef5da8', hint: 'Movies, Music and Pictures, including photo libraries.' },
  { id: 'downloads', label: 'Downloads', color: '#2fbf71', hint: 'Everything in your Downloads folder.' },
  { id: 'caches', label: 'Caches & Logs', color: '#f5a623', hint: 'Temporary files apps rebuild automatically. Generally safe to clear.' },
  { id: 'dev', label: 'Developer', color: '#9b6ef3', hint: 'node_modules, build output, SDKs, simulators and package caches.' },
  { id: 'appdata', label: 'App Data', color: '#38bdf8', hint: 'Settings and support files apps keep in ~/Library.' },
  { id: 'mail', label: 'Mail', color: '#2dd4bf', hint: 'Local copies of email and attachments.' },
  { id: 'cloud', label: 'Cloud Storage', color: '#67e8f9', hint: 'Local files synced from iCloud Drive, Dropbox, Google Drive…' },
  { id: 'backups', label: 'Device Backups', color: '#fb7185', hint: 'iPhone / iPad backups made by Finder.' },
  { id: 'apps', label: 'Applications', color: '#fb923c', hint: 'Apps installed in your home folder.' },
  { id: 'trash', label: 'Trash', color: '#a1a1aa', hint: 'Deleted files that have not been emptied yet.' },
  { id: 'dotfiles', label: 'Tools & Config', color: '#94a3b8', hint: 'Hidden tool and configuration folders in your home directory.' },
  { id: 'other', label: 'Other', color: '#64748b', hint: 'Everything else.' },
];

const DEV_DOTDIRS =
  /^(\.npm|\.yarn|\.pnpm|\.bun|\.deno|\.nvm|\.cargo|\.rustup|\.gradle|\.m2|\.ivy2|\.sbt|\.cocoapods|\.docker|\.android|\.gem|\.pyenv|\.rbenv|\.conda|\.uv|miniconda3|anaconda3|go)\//;

/**
 * Assign a path to exactly one category, so category totals always add up
 * to the scanned total. `rel` is the path relative to the home directory
 * using '/' separators. Directory paths must end with '/'.
 * First match wins, so order matters.
 */
function categorize(rel) {
  if (rel.startsWith('.Trash/')) return 'trash';
  if (rel.startsWith('Library/Caches/') || rel.startsWith('Library/Logs/') || rel.startsWith('.cache/')) return 'caches';
  if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) return 'dev';
  if (DEV_DOTDIRS.test(rel)) return 'dev';
  if (rel.startsWith('Library/Developer/') || rel.startsWith('Library/Android/')) return 'dev';
  if (rel.startsWith('Library/Containers/com.docker.docker/')) return 'dev';
  if (rel.includes('/.git/')) return 'dev';
  if (rel.startsWith('Library/Application Support/MobileSync/')) return 'backups';
  if (rel.startsWith('Library/Mail/')) return 'mail';
  if (rel.startsWith('Library/CloudStorage/') || rel.startsWith('Dropbox/')) return 'cloud';
  if (rel.startsWith('Library/')) return 'appdata';
  if (rel.startsWith('Downloads/')) return 'downloads';
  if (rel.startsWith('Movies/') || rel.startsWith('Music/') || rel.startsWith('Pictures/')) return 'media';
  if (rel.startsWith('Documents/') || rel.startsWith('Desktop/')) return 'documents';
  if (rel.startsWith('Applications/')) return 'apps';
  if (rel.startsWith('.')) return 'dotfiles';
  return 'other';
}

module.exports = { CATEGORIES, categorize };
