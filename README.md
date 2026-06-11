# Storage Manager

A lightweight, local macOS storage manager. Scan your disk, see exactly what's eating the space, and clean it up safely — with optional AI-powered recommendations.

No Electron, no accounts, no telemetry: a tiny Node server (one dependency) plus a static web UI, all running on `localhost`. Your file list never leaves your Mac unless you explicitly ask the AI advisor for a plan.

## Features

- **Whole-Mac X-ray** — "Scan this Mac" covers your home folder **plus** `/Applications`, `/Library`, Homebrew (`/opt`, `/usr/local`) and system data (`/private/var`), broken down into understandable categories (Caches & Logs, Developer, Applications, System Library, …) with a donut chart and drill-down folder browser. You can also scan any single folder.
- **Apps by size** — every installed app ranked by real size with its last-opened date (via Spotlight), so "8 GB, last opened 14 months ago" is one glance away. Removal happens via Finder, as macOS intends.
- **Cleanup recommendations** — rule-based suggestions grouped by risk:
  - *Safe to clean*: app caches, logs, package-manager caches (npm/cargo/Gradle/…), Xcode DerivedData, Mail attachment previews, Trash.
  - *Review first*: old Downloads, stale `node_modules`, iPhone backups, Xcode simulators, huge files untouched for 6+ months, large files added in the last 30 days, apps you haven't opened in 6+ months, system-wide caches.
  - System-area suggestions (apps, `/Library`, Homebrew) are advisory: the app tells you *how* to reclaim the space (Finder, `brew cleanup`, admin terminal) but never deletes outside your home folder itself.
- **AI cleanup advisor (optional)** — sends a compact summary (folder names + sizes only, never file contents) to Anthropic or OpenAI with your own API key and renders a tailored, prioritized plan with one-click cleanup for verified paths.
- **Safe by design** — deletions go to the **Trash** (recoverable, with Finder "Put Back" support), never `rm -rf`. The app refuses to touch anything outside your home folder or whole standard folders like `~/Documents`. Space is freed when you empty the Trash, which the app offers as an explicit, separate step.

## Quick start

Requires Node.js ≥ 18 (built with Node 22).

```bash
npm install
npm start
```

Your browser opens `http://localhost:4823` automatically (use `node server.js --no-open` to skip that, `PORT=5000 npm start` to change the port). Click **Scan my storage** — a first full home-folder scan typically takes a minute or two.

## AI setup (optional)

1. Click the gear icon (top right).
2. Pick a provider and paste an API key:
   - **Anthropic** — default model `claude-sonnet-4-6`
   - **OpenAI** — default model `gpt-5.4-mini`
3. After a scan, hit **Generate cleanup plan**.

The key is stored locally in `data/config.json` (file mode `600`, gitignored) and is only ever sent to the provider you chose.

## macOS permissions

- **Full Disk Access** — macOS protects some locations (Photos library, Safari data, Trash, Mail, …). The permission follows the app the server was **launched from**: if you run `npm start` in Terminal, Terminal needs Full Disk Access; if you launch it from an IDE like Cursor or VS Code, that IDE needs it. Grant it in *System Settings → Privacy & Security → Full Disk Access*, restart the server, and rescan.
- **Finder automation** — the first time you move something to the Trash, macOS asks to let your terminal control Finder. If you decline, the app falls back to moving items into `~/.Trash` directly.

## Notes on the numbers

- Sizes are **allocated disk usage** (like `du`), so sparse, compressed, and cloud-placeholder files are counted by what they actually occupy on disk. Totals can therefore differ slightly from Finder's "Get Info".
- Files hard-linked in several places are counted once per location (a small over-estimate, e.g. with pnpm stores).
- The scanner stays on your boot volume and skips symlinks, so external drives and network mounts are never touched.

## Project layout

```
server.js          Express server + API (scan, browse, trash, AI)
src/scanner.js     Concurrent filesystem scanner
src/categories.js  Category definitions & path classifier
src/recommend.js   Rule-based cleanup recommendations
src/llm.js         Anthropic / OpenAI integration
src/trash.js       Safe move-to-Trash (Finder, with fallback)
src/settings.js    Local config persistence
public/            Static UI (no build step, no framework)
```
