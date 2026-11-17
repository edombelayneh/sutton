# Changelog: what we changed and why

Newest entries at the top.

## UX: make fixes obvious and actionable
- **Fixed cells are now solid green with a "✨ Fixed" card (was faint blue).** Why: in hand-testing the blue was easy to miss.
- **A fixed cell is never red.** If a fixed value still has a problem (e.g. an uppercased SKU that's a duplicate), it stays green with "Still needs you: …" underneath. Why: red + blue together left the user unsure whether to act.
- **✓ Keep / ↶ Undo on every fix, plus "✓ Confirm all N fixes" in the banner.** Why: the admin needs a clear way to say "yes, that's right" and move on.
- **Status column per row: ● Ready / ● Check N fixes / ● Needs you: N fields.** Why: each row now says exactly what (if anything) the admin has to do.
- **Ambiguous auto-fixes (e.g. `05/07/2024` dates) must be confirmed before they import.** Why: we never silently import a guess.

## Phase 2a: safe auto-fixes
- **Added `shared/autofix.js`: deterministic fixes applied right after column mapping.** Fixes: trim/uppercase SKUs, trim names, category words (`Raw Material` → RAW), UoM case (`ea` → EA), `$` signs, comma decimals (`0,26` → 0.26), thousands separators (`1,200`), yes/1/TRUE → true, dates (`Jan 7, 2024`, `05/07/2024`) → YYYY-MM-DD, tags lowercased and de-duplicated. Why: these are tedious, unambiguous fixes the admin would otherwise do by hand in Excel. On the messy sample, valid rows go from **139 → 165**.
- **Only "safe" fixes are automatic.** `TBD` costs, negative costs, `12.5` quantities, `maybe`, `Misc`, broken JSON and duplicates are left for the user. Why: guessing there could silently import wrong data, which breaks the admin's trust.
- **Ambiguous dates (e.g. `05/07/2024`) are converted as US MM/DD but highlighted amber "please double-check".** Why: it's probably right for a US warehouse, but the admin should confirm instead of us hiding the assumption.
- **Every fix is visible and undoable**: blue cells, "was X" with the reason, a ↶ undo button, an "Auto-fixed" filter and a summary banner. Why: "trust what got in" means no silent changes.
- **The clean sample produces 0 fixes.** Why: a sanity check that auto-fix never touches good data.

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
