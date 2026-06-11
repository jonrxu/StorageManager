'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

const state = {
  settings: null,
  result: null,
  selection: new Map(), // path -> { bytes }
  explorerPath: null,
  activeTab: 'folders',
  polling: null,
  aiResult: null,
  confirmAction: null,
};

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  disk: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3"><circle cx="32" cy="32" r="26"/><circle cx="32" cy="32" r="10"/><circle cx="32" cy="32" r="2.5" fill="currentColor"/><path d="M32 6a26 26 0 0 1 26 26" stroke-width="6" stroke-linecap="round" opacity="0.5"/></svg>',
};

// ------------------------------------------------------------------ helpers
function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${i === 0 ? Math.round(n) : n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

const fmtCount = (n) => Number(n || 0).toLocaleString();

function fmtAgo(ts) {
  if (!ts) return '';
  const days = Math.max(0, Math.floor((Date.now() - ts) / 864e5));
  if (days === 0) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortPath(p) {
  const home = state.result?.home;
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p;
}

function midTruncate(s, max = 72) {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.62);
  return s.slice(0, head) + '…' + s.slice(s.length - (max - head - 1));
}

async function api(url, body) {
  const opts = body !== undefined
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, type = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// --------------------------------------------------------------------- disk
async function loadDisk() {
  try {
    const d = await api('/api/disk');
    $('#diskPill').hidden = false;
    $('#diskFree').textContent = fmtBytes(d.freeBytes);
    $('#diskTotal').textContent = fmtBytes(d.totalBytes);
    $('#diskBarFill').style.width = `${Math.min(100, (d.usedBytes / d.totalBytes) * 100).toFixed(1)}%`;
  } catch { /* gauge is cosmetic */ }
}

// --------------------------------------------------------------------- hero
function renderHero() {
  $('#rescanBtn').hidden = !state.result;
  view.innerHTML = `
    <section class="hero card">
      <div class="hero-icon">${ICONS.disk}</div>
      <h2>See what's eating your disk</h2>
      <p class="muted">Scans your files locally, shows where the space goes, and recommends what's safe to clean.
      Nothing leaves this Mac unless you ask the optional AI advisor for a plan.</p>
      <form class="hero-form" id="scanForm">
        <input id="scanPath" value="~" spellcheck="false" autocomplete="off" aria-label="Folder to scan">
        <button class="btn primary big" type="submit">Scan my storage</button>
      </form>
      <p class="fineprint">Leave it at <code>~</code> to scan your whole home folder — that's where almost all reclaimable space lives. A first full scan typically takes a minute or two.</p>
    </section>`;
  $('#scanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    startScan($('#scanPath').value.trim() || '~');
  });
}

// --------------------------------------------------------------------- scan
async function startScan(path) {
  try {
    await api('/api/scan', { path });
    state.aiResult = null;
    renderProgress();
    startPolling();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderProgress() {
  $('#rescanBtn').hidden = true;
  view.innerHTML = `
    <section class="card progress-card">
      <div class="scan-spinner"></div>
      <h2>Scanning your storage…</h2>
      <div class="progress-track"><div class="progress-glow"></div></div>
      <div class="progress-stats">
        <div><strong id="pFiles">0</strong><span>files</span></div>
        <div><strong id="pBytes">0 B</strong><span>found</span></div>
        <div><strong id="pElapsed">0s</strong><span>elapsed</span></div>
      </div>
      <p class="progress-path mono" id="pPath"></p>
      <button class="btn ghost" id="cancelScanBtn">Cancel</button>
    </section>`;
  $('#cancelScanBtn').addEventListener('click', async () => {
    await api('/api/scan/cancel', {}).catch(() => {});
  });
}

function updateProgress(p) {
  if (!$('#pFiles')) return;
  $('#pFiles').textContent = fmtCount(p.files);
  $('#pBytes').textContent = fmtBytes(p.bytes);
  $('#pElapsed').textContent = `${Math.round(p.elapsedMs / 1000)}s`;
  $('#pPath').textContent = midTruncate(p.currentPath || '', 90);
}

function startPolling() {
  stopPolling();
  state.polling = setInterval(async () => {
    try {
      const st = await api('/api/scan/status');
      if (st.state === 'running') {
        if (st.progress) updateProgress(st.progress);
      } else if (st.state === 'done' && st.result) {
        stopPolling();
        state.result = st.result;
        loadDisk();
        renderResults();
      } else if (st.state === 'error') {
        stopPolling();
        toast(`Scan failed: ${st.error || 'unknown error'}`, 'error');
        renderHero();
      } else {
        stopPolling(); // cancelled
        renderHero();
      }
    } catch { /* server hiccup — keep polling */ }
  }, 700);
}

function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
}

// ------------------------------------------------------------------ results
function renderResults() {
  const r = state.result;
  $('#rescanBtn').hidden = false;
  state.selection.clear();
  updateSelectionBar();

  const safeBytes = r.recommendations.filter((x) => x.risk === 'safe').reduce((s, x) => s + x.bytes, 0);

  view.innerHTML = `
    ${r.errors && r.errors.permission > 0 ? `
      <div class="banner">${fmtCount(r.errors.permission)} protected items couldn't be read (macOS privacy) — often including your Photos library and Trash.
      Full Disk Access follows the app the server was <em>launched from</em> (Terminal, Cursor, …). Give that app <strong>Full Disk Access</strong> in System Settings → Privacy &amp; Security, then restart the server and rescan.</div>` : ''}

    <section class="summary-row">
      <div class="card donut-card">
        <h3>Storage composition</h3>
        <div class="donut-wrap" id="donutWrap">
          <div id="donut"></div>
          <div class="donut-center"><strong>${fmtBytes(r.totalBytes)}</strong><span>${escapeHtml(shortPath(r.root))}</span></div>
        </div>
        <p class="muted small">${fmtCount(r.filesScanned)} files · scanned in ${(r.durationMs / 1000).toFixed(1)}s</p>
        <button class="link" id="newScanLink">Scan a different folder…</button>
      </div>
      <div class="card cat-card">
        <h3>By category</h3>
        <p class="muted small">Click a category to see what's inside it.</p>
        <div id="catList"></div>
      </div>
    </section>

    <section class="card" id="recsCard">
      <div class="card-head">
        <div>
          <h3>Cleanup recommendations</h3>
          <p class="muted small">${safeBytes > 0 ? `At least <strong>${fmtBytes(safeBytes)}</strong> of safe-to-clean space found. ` : ''}Tick items, then use the bar at the bottom to move them to the Trash.</p>
        </div>
      </div>
      <div id="recList"></div>
    </section>

    <section class="card ai-card" id="aiCard"></section>

    <section class="card" id="explorerCard">
      <div class="card-head"><div>
        <h3>Explore</h3>
        <p class="muted small">Drill into folders, or jump straight to the biggest and newest files.</p>
      </div></div>
      <div class="tabs" id="explorerTabs">
        <button data-tab="folders" class="tab active">Largest folders</button>
        <button data-tab="files" class="tab">Largest files</button>
        <button data-tab="recent" class="tab">Recently added</button>
      </div>
      <div id="explorerBody"></div>
    </section>`;

  renderDonut();
  renderCategories();
  renderRecs();
  renderAiPanel();
  $('#newScanLink').addEventListener('click', renderHero);
  $('#explorerTabs').addEventListener('click', onTabClick);
  state.activeTab = 'folders';
  state.explorerPath = r.root;
  explorerGo(r.root);
}

// donut ---------------------------------------------------------------------
function renderDonut() {
  const r = state.result;
  const total = r.totalBytes || 1;
  const C = 2 * Math.PI * 84;
  let offset = 0;
  const segs = r.categories
    .map((c) => {
      const frac = c.bytes / total;
      const len = Math.max(frac * C - 2.5, 0.5);
      const seg = `<circle r="84" cx="110" cy="110" class="donut-seg" data-seg="${c.id}" stroke="${c.color}"
        stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset * C).toFixed(2)}">
        <title>${escapeHtml(c.label)} — ${fmtBytes(c.bytes)}</title></circle>`;
      offset += frac;
      return seg;
    })
    .join('');
  $('#donut').innerHTML = `<svg viewBox="0 0 220 220">${segs}</svg>`;

  const wrap = $('#donutWrap');
  wrap.addEventListener('mouseover', (e) => {
    const seg = e.target.closest('.donut-seg');
    if (!seg) return;
    wrap.classList.add('faded');
    wrap.querySelectorAll('.donut-seg').forEach((s) => s.classList.toggle('hl', s === seg));
    document.querySelectorAll('.cat-row').forEach((row) => row.classList.toggle('hl', row.dataset.cat === seg.dataset.seg));
  });
  wrap.addEventListener('mouseleave', () => {
    wrap.classList.remove('faded');
    wrap.querySelectorAll('.donut-seg').forEach((s) => s.classList.remove('hl'));
    document.querySelectorAll('.cat-row').forEach((row) => row.classList.remove('hl'));
  });
}

// categories ----------------------------------------------------------------
function renderCategories() {
  const r = state.result;
  const total = r.totalBytes || 1;
  $('#catList').innerHTML = r.categories
    .map(
      (c) => `
      <div class="cat-row" data-cat="${c.id}">
        <button class="cat-main" data-cat-toggle title="${escapeHtml(c.hint)}">
          <span class="cat-dot" style="background:${c.color}"></span>
          <span class="cat-name">${escapeHtml(c.label)}</span>
          <span class="cat-bytes">${fmtBytes(c.bytes)}</span>
          <span class="cat-pct">${((c.bytes / total) * 100).toFixed(1)}%</span>
        </button>
        <div class="cat-bar"><div style="width:${Math.max((c.bytes / total) * 100, 0.4).toFixed(2)}%;background:${c.color}"></div></div>
        <div class="cat-tops" hidden>
          ${c.topDirs
            .map(
              (d) => `<button class="cat-top" data-goto="${escapeHtml(d.path)}">
                <span class="mono">${escapeHtml(shortPath(d.path))}</span><span>${fmtBytes(d.bytes)}</span></button>`
            )
            .join('') || '<p class="muted small">Mostly lots of small files — explore below for details.</p>'}
        </div>
      </div>`
    )
    .join('');
}

// recommendations ------------------------------------------------------------
function renderRecs() {
  const r = state.result;
  const groups = [
    ['safe', 'Safe to clean', 'Rebuilt or re-downloaded automatically when needed.'],
    ['caution', 'Review before deleting', 'Probably fine to remove — but make sure you no longer need them.'],
  ];
  $('#recList').innerHTML =
    groups
      .map(([risk, title, sub]) => {
        const recs = r.recommendations.filter((x) => x.risk === risk);
        if (!recs.length) return '';
        return `<div class="rec-group">
          <div class="rec-group-head"><span class="badge ${risk}">${title}</span><span class="muted small">${sub}</span></div>
          ${recs.map(recCard).join('')}
        </div>`;
      })
      .join('') || '<p class="muted">Nothing significant to clean up — your disk looks tidy.</p>';

  const emptyBtn = $('#emptyTrashBtn');
  if (emptyBtn) emptyBtn.addEventListener('click', confirmEmptyTrash);
}

function recCard(rec) {
  return `<details class="rec" data-rec="${rec.id}">
    <summary>
      <input type="checkbox" class="check rec-check" ${rec.actionable ? '' : 'disabled'} aria-label="Select everything in this group">
      <div class="rec-title">
        <strong>${escapeHtml(rec.title)}</strong>
        <p class="muted small">${escapeHtml(rec.description)}</p>
      </div>
      <span class="rec-bytes">${fmtBytes(rec.bytes)}</span>
      <span class="chev">›</span>
    </summary>
    <div class="rec-items">
      ${rec.special === 'emptyTrash' ? '<p style="margin:10px 0 6px"><button class="btn danger small" id="emptyTrashBtn">Empty Trash…</button></p>' : ''}
      ${rec.items.map((it) => itemRow(it, rec.actionable)).join('')}
      ${rec.hint ? `<p class="muted small hint">${escapeHtml(rec.hint)}</p>` : ''}
    </div>
  </details>`;
}

function itemRow(it, actionable) {
  return `<label class="item-row">
    <input type="checkbox" class="check item-check" data-path="${escapeHtml(it.path)}" data-bytes="${it.bytes}"
      ${actionable ? '' : 'disabled'} ${state.selection.has(it.path) ? 'checked' : ''}>
    <span class="mono item-path" title="${escapeHtml(it.path)}">${escapeHtml(shortPath(it.path))}</span>
    ${it.note ? `<span class="item-note">${escapeHtml(it.note)}</span>` : '<span class="item-note"></span>'}
    <span class="item-bytes">${fmtBytes(it.bytes)}</span>
  </label>`;
}

// AI panel --------------------------------------------------------------------
function providerName() {
  return state.settings?.provider === 'openai' ? 'OpenAI' : 'Anthropic';
}

function renderAiPanel() {
  const el = $('#aiCard');
  const hasKey = state.settings?.hasKey;
  el.innerHTML = `
    <div class="card-head">
      <div>
        <h3>AI cleanup advisor</h3>
        <p class="muted small">Sends a compact summary — folder names and sizes only, never file contents —
        to ${providerName()} and turns the answer into a tailored, prioritized plan.</p>
      </div>
      <button class="btn primary" id="aiBtn">${hasKey ? (state.aiResult ? 'Regenerate plan' : 'Generate cleanup plan') : 'Set up AI…'}</button>
    </div>
    <div id="aiBody">${state.aiResult ? '' : '<p class="muted small">Optional — the recommendations above already work without it.</p>'}</div>`;
  $('#aiBtn').addEventListener('click', () => (state.settings?.hasKey ? runAi() : openSettings()));
  if (state.aiResult) renderAiResult();
}

async function runAi() {
  const btn = $('#aiBtn');
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  $('#aiBody').innerHTML = `<div class="ai-loading"><div class="scan-spinner small"></div>
    <p class="muted small">Asking ${providerName()} for a tailored plan — usually 10–30 seconds…</p></div>`;
  try {
    state.aiResult = await api('/api/ai/analyze', {});
    renderAiResult();
  } catch (e) {
    state.aiResult = null;
    const msg = e.message === 'no-key' ? 'Add an API key first (gear icon, top right).' : e.message;
    $('#aiBody').innerHTML = `<p class="error-text small">${escapeHtml(msg)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = state.aiResult ? 'Regenerate plan' : 'Generate cleanup plan';
  }
}

function renderAiResult() {
  const a = state.aiResult;
  $('#aiBody').innerHTML = `
    ${a.headline ? `<p class="ai-headline">${escapeHtml(a.headline)}</p>` : ''}
    ${a.observations?.length ? `<ul class="ai-observations">${a.observations.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>` : ''}
    <div class="ai-recs">${(a.recommendations || []).map(aiRecCard).join('')}</div>
    ${a.warnings?.length ? `<div class="ai-warnings"><strong>The model says keep these:</strong>
      <ul>${a.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : ''}
    ${a.rawText ? `<pre class="mono small">${escapeHtml(a.rawText)}</pre>` : ''}
    <p class="muted small" style="margin-top:12px">Generated by ${escapeHtml(a.model || 'the model')}. Suggestions can be wrong — double-check anything you don't recognize.</p>`;
}

function aiRecCard(rec) {
  const bytes = rec.verifiedBytes || rec.estimatedBytes;
  return `<div class="ai-rec risk-${rec.risk}">
    <div class="ai-rec-head">
      <span class="badge ${rec.risk}">${rec.risk}</span>
      <strong>${escapeHtml(rec.title)}</strong>
      <span class="rec-bytes">${bytes ? '~' + fmtBytes(bytes) : ''}</span>
    </div>
    <p class="muted small">${escapeHtml(rec.why)}</p>
    ${rec.how ? `<p class="ai-how mono">${escapeHtml(rec.how)}</p>` : ''}
    ${rec.items?.length ? `<div class="rec-items">${rec.items
        .map((it) =>
          it.exists && it.trashable
            ? itemRow({ path: it.path, bytes: it.bytes }, true)
            : `<div class="item-row dead">
                <span class="mono item-path" title="${escapeHtml(it.path)}">${escapeHtml(shortPath(it.path))}</span>
                <span class="item-note">${it.exists ? 'protected' : 'not found'}</span>
                <span class="item-bytes">${fmtBytes(it.bytes)}</span></div>`
        )
        .join('')}</div>` : ''}
  </div>`;
}

// explorer --------------------------------------------------------------------
function onTabClick(e) {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  setActiveTab(tab.dataset.tab);
}

function setActiveTab(name) {
  state.activeTab = name;
  document.querySelectorAll('#explorerTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const r = state.result;
  if (name === 'folders') explorerGo(state.explorerPath || r.root);
  else if (name === 'files') renderFileList(r.largeFiles, 'mtime', 'No files over 50 MB found.');
  else renderFileList(r.recentFiles, 'birthtime', 'No sizable files added in the last 30 days.');
}

async function explorerGo(p) {
  state.explorerPath = p;
  const body = $('#explorerBody');
  if (!body) return;
  body.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await api('/api/dir?path=' + encodeURIComponent(p));
    if (state.activeTab !== 'folders' || state.explorerPath !== p) return;
    renderExplorer(data);
  } catch (e) {
    body.innerHTML = `<p class="muted pad">${escapeHtml(e.message)}</p>`;
  }
}

function renderExplorer(data) {
  const max = Math.max(...data.entries.map((e) => e.bytes), 1);
  $('#explorerBody').innerHTML = `
    <div class="crumbs">${breadcrumb(data.path, data.root)}</div>
    <div class="x-list">
      ${data.entries
        .map(
          (ent) => `
        <div class="x-row ${ent.isDir ? 'is-dir' : ''}">
          <input type="checkbox" class="check item-check" data-path="${escapeHtml(ent.path)}" data-bytes="${ent.bytes}"
            ${state.selection.has(ent.path) ? 'checked' : ''}>
          <span class="x-icon">${ent.isDir ? ICONS.folder : ICONS.file}</span>
          ${ent.isDir
            ? `<button class="x-name" data-goto="${escapeHtml(ent.path)}" title="${escapeHtml(ent.name)}">${escapeHtml(ent.name)}</button>`
            : `<span class="x-name" title="${escapeHtml(ent.name)}">${escapeHtml(ent.name)}</span>`}
          <span class="x-bar"><i style="width:${((ent.bytes / max) * 100).toFixed(1)}%"></i></span>
          <span class="x-bytes">${fmtBytes(ent.bytes)}</span>
        </div>`
        )
        .join('') || '<p class="muted pad">Empty folder.</p>'}
    </div>`;
}

function breadcrumb(p, root) {
  const parts = [];
  let cur = p;
  while (cur.length >= root.length) {
    parts.unshift({ path: cur, name: cur === root ? shortPath(root) : cur.split('/').pop() });
    if (cur === root) break;
    cur = cur.slice(0, cur.lastIndexOf('/')) || root;
  }
  return parts
    .map((part, i) => {
      const last = i === parts.length - 1;
      return last
        ? `<span class="crumb current">${escapeHtml(part.name)}</span>`
        : `<button class="crumb" data-goto="${escapeHtml(part.path)}">${escapeHtml(part.name)}</button><span class="crumb-sep">/</span>`;
    })
    .join('');
}

function renderFileList(files, ageField, emptyMsg) {
  $('#explorerBody').innerHTML = files.length
    ? `<div class="x-list">
        ${files
          .map(
            (f) => `
          <div class="x-row">
            <input type="checkbox" class="check item-check" data-path="${escapeHtml(f.path)}" data-bytes="${f.bytes}"
              ${state.selection.has(f.path) ? 'checked' : ''}>
            <span class="x-icon">${ICONS.file}</span>
            <span class="x-name mono" title="${escapeHtml(f.path)}">${escapeHtml(shortPath(f.path))}</span>
            <span class="x-age">${ageField === 'birthtime' ? 'added ' : ''}${fmtAgo(f[ageField])}</span>
            <span class="x-bytes">${fmtBytes(f.bytes)}</span>
          </div>`
          )
          .join('')}
      </div>`
    : `<p class="muted pad">${emptyMsg}</p>`;
}

// selection & trash -------------------------------------------------------------
function toggleSelection(path, bytes, on) {
  if (on) state.selection.set(path, { bytes });
  else state.selection.delete(path);
  document.querySelectorAll('.item-check').forEach((cb) => {
    if (cb.dataset.path === path && cb.checked !== on) cb.checked = on;
  });
  updateSelectionBar();
}

function updateSelectionBar() {
  const n = state.selection.size;
  $('#selectionBar').hidden = n === 0;
  if (!n) return;
  let total = 0;
  state.selection.forEach((v) => (total += v.bytes));
  $('#selectionInfo').textContent = `${n} item${n === 1 ? '' : 's'} · ${fmtBytes(total)}`;
}

function clearSelection() {
  [...state.selection.keys()].forEach((p) => toggleSelection(p, 0, false));
}

function confirmSelectionTrash() {
  const items = [...state.selection.entries()].map(([path, v]) => ({ path, bytes: v.bytes }));
  if (!items.length) return;
  const total = items.reduce((s, i) => s + i.bytes, 0);
  openConfirm({
    title: `Move ${items.length} item${items.length === 1 ? '' : 's'} (${fmtBytes(total)}) to the Trash?`,
    text: 'Everything stays recoverable in the Trash. Disk space is actually freed once you empty it.',
    items,
    confirmLabel: 'Move to Trash',
    action: async (btn) => {
      btn.disabled = true;
      btn.textContent = 'Moving…';
      try {
        await doTrash(items.map((i) => i.path));
      } finally {
        btn.disabled = false;
        btn.textContent = 'Move to Trash';
      }
    },
  });
}

async function doTrash(paths) {
  try {
    const res = await api('/api/trash', { paths });
    closeModals();
    const ok = new Set(res.results.filter((r) => r.ok).map((r) => r.path));
    const failed = res.results.filter((r) => !r.ok);
    if (res.okCount) toast(`Moved ${res.okCount} item${res.okCount === 1 ? '' : 's'} (~${fmtBytes(res.freedBytes)}) to the Trash.`, 'success');
    failed.slice(0, 3).forEach((f) => toast(`Couldn't trash ${midTruncate(shortPath(f.path), 40)}: ${f.error}`, 'error', 7000));

    document.querySelectorAll('.item-check').forEach((cb) => {
      if (ok.has(cb.dataset.path)) {
        cb.checked = false;
        cb.disabled = true;
        cb.closest('.item-row, .x-row')?.classList.add('deleted');
      }
    });
    ok.forEach((p) => state.selection.delete(p));
    updateSelectionBar();

    if (res.okCount) setTimeout(offerEmptyTrash, 600);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function offerEmptyTrash() {
  openConfirm({
    title: 'Free the space now?',
    text: 'The items now sit in your Trash, so the disk space is not free yet. Emptying the Trash permanently deletes everything in it — including anything that was already there.',
    items: [],
    confirmLabel: 'Empty Trash',
    action: emptyTrashAction,
  });
}

function confirmEmptyTrash() {
  openConfirm({
    title: 'Empty the Trash?',
    text: 'This permanently deletes everything in the Trash. It cannot be undone.',
    items: [],
    confirmLabel: 'Empty Trash',
    action: emptyTrashAction,
  });
}

async function emptyTrashAction(btn) {
  btn.disabled = true;
  btn.textContent = 'Emptying…';
  try {
    await api('/api/trash/empty', {});
    closeModals();
    toast('Trash emptied — space reclaimed.', 'success');
    loadDisk();
  } catch (e) {
    toast(`Couldn't empty the Trash: ${e.message}`, 'error', 7000);
    closeModals();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Empty Trash';
  }
}

// modals -------------------------------------------------------------------------
function openConfirm({ title, text, items, confirmLabel, action }) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmList').innerHTML =
    items
      .slice(0, 10)
      .map((i) => `<li><span>${escapeHtml(shortPath(i.path))}</span><span>${fmtBytes(i.bytes)}</span></li>`)
      .join('') + (items.length > 10 ? `<li class="more">…and ${items.length - 10} more</li>` : '');
  $('#confirmBtn').textContent = confirmLabel;
  state.confirmAction = action;
  $('#confirmModal').hidden = false;
}

function openSettings() {
  const s = state.settings || {};
  $('#providerSelect').value = s.provider || 'anthropic';
  $('#modelInput').value = s.model || '';
  $('#apiKeyInput').value = '';
  syncSettingsHints();
  $('#settingsModal').hidden = false;
}

function syncSettingsHints() {
  const s = state.settings || {};
  const provider = $('#providerSelect').value;
  const def = s.defaultModels?.[provider] || '';
  $('#modelInput').placeholder = def ? `default: ${def}` : 'model id';
  $('#keyStatus').textContent = s.hasKey
    ? `A key is saved (${s.keyHint}). Leave the field blank to keep it.`
    : 'No key saved yet.';
}

async function saveSettings() {
  const body = {
    provider: $('#providerSelect').value,
    model: $('#modelInput').value.trim(),
  };
  const key = $('#apiKeyInput').value.trim();
  if (key) body.apiKey = key;
  try {
    state.settings = await api('/api/settings', body);
    closeModals();
    toast('Settings saved.', 'success');
    if ($('#aiCard')) renderAiPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach((m) => (m.hidden = true));
  state.confirmAction = null;
}

// global wiring -------------------------------------------------------------------
function wireChrome() {
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#rescanBtn').addEventListener('click', () => state.result && startScan(state.result.root));
  $('#selectionClear').addEventListener('click', clearSelection);
  $('#selectionTrash').addEventListener('click', confirmSelectionTrash);
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#providerSelect').addEventListener('change', syncSettingsHints);
  $('#confirmBtn').addEventListener('click', async (e) => {
    if (state.confirmAction) await state.confirmAction(e.currentTarget);
  });

  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) closeModals();
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModals();
  });

  // One delegated handler covers checkboxes everywhere (recs, AI, explorer).
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.classList.contains('item-check')) {
      toggleSelection(t.dataset.path, Number(t.dataset.bytes) || 0, t.checked);
    } else if (t.classList.contains('rec-check')) {
      const details = t.closest('details.rec');
      if (!details) return;
      details.querySelectorAll('.item-check:not(:disabled)').forEach((cb) => {
        if (cb.checked !== t.checked) toggleSelection(cb.dataset.path, Number(cb.dataset.bytes) || 0, t.checked);
      });
      if (t.checked) details.open = true;
    }
  });

  // Delegated navigation: category drill-ins, breadcrumbs, folder rows.
  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      const inExplorer = Boolean(goto.closest('#explorerCard'));
      setActiveTab('folders');
      explorerGo(goto.dataset.goto);
      if (!inExplorer) $('#explorerCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const catToggle = e.target.closest('[data-cat-toggle]');
    if (catToggle) {
      const tops = catToggle.closest('.cat-row')?.querySelector('.cat-tops');
      if (tops) tops.hidden = !tops.hidden;
    }
  });
}

// init ------------------------------------------------------------------------------
async function init() {
  wireChrome();
  loadDisk();
  state.settings = await api('/api/settings').catch(() => null);
  const status = await api('/api/scan/status').catch(() => ({ state: 'idle' }));
  if (status.state === 'running') {
    renderProgress();
    startPolling();
  } else if (status.state === 'done' && status.result) {
    state.result = status.result;
    renderResults();
  } else {
    renderHero();
  }
}

init();
