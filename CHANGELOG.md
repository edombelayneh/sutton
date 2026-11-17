# Changelog: what we changed and why

Newest entries at the top.

## Fix: rows vanished while typing
- **Edited rows now stay visible in "Needs attention" and turn green with "✓ Fixed".** Why: the filter hid a row the moment it became valid, even partway through a word, so the admin couldn't finish typing and got no confirmation the fix worked. Clicking "Needs attention" again clears the fixed rows away. (Found by hand-testing.)

## Phase 1: working importer
- **Shared validation module (`shared/schema.js`).** Why: the same rules run in the browser (instant feedback while editing) and on the server (the source of truth on import), so they can never disagree.
- **Header auto-mapping with aliases** (`"SKU "` → sku, `Unit Cost ($)` → unit_cost). Why: the admin's spreadsheet won't match our field names; they shouldn't have to rename columns.
- **Express API + JSON-file store.** Why: "existing records" need to persist so SKU uniqueness can be checked against what's already in the system. A JSON file needs zero setup.
- **Partial import (valid rows go in, invalid rows are held back with reasons).** Why: one bad row shouldn't block 180 good ones, and the admin can see exactly what didn't get in.
- **`npm run dev` starts both the API and the web app** (via `concurrently`). Why: one command to run.
- **Copied the sample CSVs into `public/samples`.** Why: one-click demo without hunting for files.

## Pre-timer setup
- **Scaffolded Vite + React + Tailwind v4.** Why: almost no setup, `npm install && npm run dev` just works, and it's the stack the motionsites plugin targets for the beautify phase.
- **Replaced the Vite demo page with a blank starting page.** Why: a clean slate so the prompt work starts immediately.
- **Dev server auto-opens the browser on port 5173.** Why: one less step for whoever runs the app.
- **Added the docs (README, PLAN, FEATURES, CHANGELOG).** Why: one shared place to plan, track decisions and explain choices in the pairing session.
- **Added `npm run zip`.** Why: resubmitting is one command, `.git` is always included and `node_modules` never is.
