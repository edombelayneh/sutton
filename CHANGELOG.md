# Changelog: what we changed and why

Newest entries at the top.

## Hardening: security and data-safety review
A review of crash, security and data-loss risks. Fixed the top 5:
- **🔴 Data loss: the store is now written atomically** (temp file + rename), and a store file that exists but can't be parsed **raises an error instead of being treated as empty**. Why: before, one half-written file meant the next import silently wiped every item.
- **🔴 The API listens on 127.0.0.1 only** (the Vite proxy points there too). Why: there's no auth, so anyone on the same network could read or delete items or spend the AI key.
- **🟠 Upgraded SheetJS `xlsx` 0.18.5 → 0.20.3** (official SheetJS distribution; the npm copy is unmaintained). Why: 0.18.5 has a known high-severity prototype-pollution / ReDoS issue with crafted Excel files. `npm audit` is now clean.
- **🟠 CSV formula injection blocked in "Download as CSV"**: cells starting with `= + - @` get a leading `'`. Why: a hostile cell like `=HYPERLINK(...)` would otherwise run when the admin opens the file in Excel.
- **🟠 Undo can no longer create duplicate SKUs**: an old version is restored only if no current item uses that SKU. The undo route also only looks up real batch ids (`__proto__` now returns 404 instead of an error).
- **Added "Clear all"** on the Imported items page (confirmed; also clears undo history so undo can't resurrect deleted items).

- **"Ask AI" is capped at 200 rows per request** (client and server); the message says to ask again for the rest. Why: bounds cost and latency on huge files.
- **Malformed rows in `/api/import` (e.g. `null`) are rejected with reasons instead of causing a 500.** Why: the server should never throw on bad input.

## Excel, multiple files, update existing, undo import
- **Excel (.xlsx/.xls) upload** via SheetJS (first sheet). Why: an admin "moving off spreadsheets" has Excel files, not CSVs.
- **Multiple files at once**, reviewed as **one combined batch**; each row shows its source file, and duplicate SKUs are caught *across* files. Why: real imports come as several sheets, and cross-file duplicates are invisible by hand.
- **"Update the existing item"** for SKUs already in the system (in the edit panel's duplicate box), shown as a blue "Will update the existing item" chip; the server only allows overwrites for SKUs explicitly listed in `updates`. Why: re-importing next month's counts is the long-term use; rejecting every known SKU would block it.
- **Undo this import** on the Results page: every import is tagged with a batch id; the batch file stores the overwritten versions, so undo removes added items **and restores updated ones**. Tested end to end (update → undo restores name and qty, item count unchanged). Why: the ultimate "trust what got in" feature.

## Final README
- **README rewritten**: run steps (with the correct Node minimum for Vite 8), what the app does step by step, how it's built (files + API), what works and the known gaps, and how we worked with the agent. Why: it's the first thing reviewers read, and it sets up the pairing conversation.

## Imported items is now a full-screen page
- **Imported items opens full screen (not a side panel)**, with ← Back, a search box, and **"Import another file" always visible in the header**. Clicking an item still opens the detail/edit panel on the right. Why: the list deserves the full width, and the next action stays in direct view.

## Results: "View imported items" button
- **Added a "View imported items" button next to "Import another file" on the Results page.** Why: right after an import, the natural next step is to check what's now in the system.

## Edit and delete imported items
- **`PUT /api/items/:sku` and `DELETE /api/items/:sku`.** Edits are sent as raw strings and **re-validated on the server** with the same `parseRow` rules as import, including SKU uniqueness if the SKU changes. Why: an edit must never let bad data in through the back door.
- **"Edit item" in the detail panel reuses the Review edit panel** (same grouped fields, size boxes, vendor list, no JSON), with live validation and a **Save changes** button that's disabled until the item is valid. Why: one editing experience for the whole app.
- **"Delete" asks "Delete SKU (name) from the system? This can't be undone."** Why: deleting is permanent, so it's always confirmed.
- The header's item count refreshes after edits/deletes.

## Imported item detail panel
- **Clicking an item in "Imported items" opens a read-only detail panel**: Basics (category and unit in words, description, tags as chips), Stock & cost, Dates (including import time), Size (L × W × H), and Vendors as a list with ★ preferred, vendor SKU, lead time and cost. Why: the same click-a-row-to-see-everything pattern as Review; the admin can verify exactly what got in, with no JSON.

## Navigation back + view imported items
- **Steps in the header and the Sutton logo are clickable to go back.** Leaving Map or Review asks "Leave this import? Your changes to this file will be lost." first. Why: the admin was stuck moving forward only, but shouldn't lose edits by a mis-click.
- **"Imported items" view** (header button with a count, plus "View N imported items →" on the Upload page): a searchable list of everything already in the system (SKU, item with size/vendors/tags as text, category, cost, stock, import time), newest first, no JSON. Why: the admin needs to trust what's already in, and check a SKU before re-importing.

## Redesign: readable list + edit panel, no JSON on screen
- **Feedback: the previous look was disliked, and the table was still a spreadsheet** (15 raw columns, JSON in cells, errors in tiny text).
- **The table is now a readable list**: Status · SKU · Item (with "92 × 50 × 14 cm · 2 vendors · ★ Acme" underneath) · Category in words ("Raw material", not RAW) · Cost as `$388.51` · Stock as `1,948` · **"What's going on"** as plain-English colored chips ("SKU shared with row 32", "Name: Name is required", "2 AI suggestions"). Why: an ops admin scans for meaning, not codes.
- **Click a row → an edit panel slides in**, grouped into Basics / Stock & cost / Dates / Size / Vendors, with each problem and fix (Keep/Undo) next to its field, ↑/↓ to jump between rows needing attention, and "Next issue →". Why: fixing one row at a time with full context is easier than editing tiny spreadsheet cells.
- **No JSON shown anywhere.** Size is three boxes plus a cm/in picker. Vendors are a small editable list (name, vendor SKU, cost, lead days, ★ preferred, only one allowed, max 3). Truncated vendor JSON is recovered as best we can: "The vendor list in your file was cut off. We recovered what we could." Data is still stored and imported as JSON.
- **Three stacked banners → one summary card**: the ready count, a progress bar, action buttons (Resolve duplicates · Ask AI · Accept AI · Confirm auto-fixes) and filter chips with counts.
- **Lighter, modern shell**: Inter, a white translucent header, a light stepper.
- **Bug found in screenshot review: the panel rendered under the sticky header** (the step animation created a stacking context). Fixed by rendering the panel in a portal. The size inputs were squeezed too; fixed with a grid.

## Phase 3: make it pretty (motionsites skill)
- **Design direction: "calm, precise, trustworthy".** One typeface (Geist) plus Geist Mono for small labels and step numbers (`01 / 04`), a dark header, pill buttons and rounded cards. Why: it's a tool an ops admin uses daily, so it should feel reliable and quiet, not flashy.
- **Signature: a live import-health bar** (ready vs needs attention) that animates as rows get fixed, plus a big `162/200 rows ready` counter. Why: the admin's one question is "how close am I?", and now it's answered at a glance.
- **Upload is now a real landing step**: a clear headline, a 3-step "Map / Fix / Trust" explainer, a drop zone with a slow animated gradient border (it speeds up on drag), and sample-file chips. Why: it explains what the app does before they commit a file.
- **Header stepper with a gradient progress line; steps fade up on change.** Why: orientation and a sense of progress. Respects `prefers-reduced-motion`.
- **Results page leads with "N items are in."** Why: answers "what got in" first, then the details.
- **Compacted the three status banners after the screenshot review.** Why: stacked, they pushed the table below the fold.
- **All functionality and the color meanings are unchanged** (purple AI, green safe fix, amber guess, orange duplicate, red needs you).

## UX: AI is purple everywhere + its own filter
- **One color per source of change: purple = AI, green = our safe fixes, amber = our guesses, orange = duplicates, red = needs you.** AI-suggested cells, their cards and the row status ("● Check N AI suggestions") are now purple to match the purple AI banner. Why: in hand-testing, a purple banner with amber rows didn't connect.
- **Rows the AI could help with show "🤖 AI can suggest a fix"** under their red status. Why: links each row back to the purple banner before AI runs.
- **New "🤖 AI (N)" filter tab** (like Duplicates / Auto-fixed) plus "Review AI suggestions" and "✓ Accept all N" in the purple banner. Why: AI suggestions get the same review-in-bulk flow as everything else.
- **AI suggestions are counted and confirmed separately from our deterministic fixes** (the green "Confirm all" no longer accepts AI suggestions). Why: approving our safe fixes shouldn't silently approve the AI's guesses too.

## Phase 2d: AI header-mapping fallback
- **`POST /api/ai/map`: only headers our alias matching couldn't place are sent to the AI, with up to 3 sample values each, plus the list of still-unused fields.** Why: headers like `Part #`, `Grp` or `Std Cost` are obvious to a human but not to a fixed alias list; sample values let the AI tell e.g. a date column from a cost column.
- **Runs automatically when the Map step opens; AI picks show "🤖 AI matched this: <why>" under the dropdown**, and columns the AI rejects show "AI: not an item field". Why: zero extra clicks, but the admin can see and override every choice.
- **The server enforces that each field is used once and only real field keys are accepted.** Why: never trust model output blindly.
- **Fails quietly**: no key or an AI error leaves the normal manual dropdowns. Why: AI is a helper, never a blocker.
- **Added `samples/items_odd_headers.csv`** (clean data, unusual headers) to demo and test this.

## Phase 2c: AI suggestions for what's left
- **`POST /api/ai/suggest`: sends only the still-broken rows (with their errors) to OpenRouter via `server/ai.js`, in parallel batches of 15.** Why: the remaining problems (`TBD` costs, `Misc` category, broken vendor JSON, missing height, discontinued-but-active) need judgment from the rest of the row, which is tedious for a human and good work for an LLM.
- **The prompt contains the full field rules and tells the model to use evidence from the row** (category from the name, cost from the preferred vendor, repair truncated JSON) **and to omit what it can't infer.** Why: we'd rather leave a blank than invent inventory data.
- **AI suggestions go through the same Keep/Undo flow, labeled "🤖 AI suggestion", always amber (must be confirmed).** Why: the AI never writes to the import without the admin approving it; everything is re-validated before import.
- **Duplicate-SKU errors are excluded from the AI** (they have their own resolver). Why: picking which product keeps a SKU is a business decision.
- **The key stays server-side, and the app works without it**: the banner says AI is off and how to enable it. Why: graders can run it without a key; the key is never shipped to the browser.

## UX: duplicates scale to any file size
- **Replaced the per-SKU card panel with a one-line banner + a "Duplicates (N)" filter tab.** Why: one card per SKU grows without limit. With 500 duplicates the cards would push the table off screen. The banner is always the same size, and the table already scrolls in a fixed-height box.
- **Duplicates view sorts items that share a SKU next to each other**, each labeled "Shared with row 32" or "Identical to row 32". Why: the comparison stays visible without separate cards.
- **Keep SKU / ✨ New SKU / Skip (or Remove copy) moved inline into each row's Status cell.** Why: one place to work, the same banner → filter → act pattern as auto-fixes.
- **"✨ Resolve all" in the banner stays the main path for big files.** Why: bulk action for the "infinite duplicates" case; new SKUs are still amber for confirmation.

## Phase 2b: duplicate SKU resolver
- **Checked the data first: all 6 duplicate pairs in the messy file are *different products* sharing a SKU** (e.g. FXBU-KHM is both "Rubber Hinge" and "Fiberglass Hex Bolt M8"). Why it matters: a plain "keep one / merge" would have silently dropped a real product, so the design changed.
- **Prominent orange "⚠ Duplicate SKUs" panel above the table**, showing each group side by side (name, category, cost, qty). Why: the user must *know* there are duplicates, not discover them cell by cell.
- **Per item: Keep SKU / ✨ New SKU / Skip.** New SKUs are generated from the item name (e.g. `FIBE-7K2`), guaranteed valid and unique against the file and existing records, and marked amber "please check" so the admin confirms them. Why: the fix takes one click, but it's still their decision.
- **Truly identical rows get "Remove extra copy"** (the merge case). Why: an accidental double paste shouldn't need a new SKU.
- **SKUs that already exist in the system are shown in the same panel** (e.g. re-importing a file). Why: the same mental model covers both kinds of conflict.
- **"✨ Resolve all"**: removes identical copies; otherwise the first item keeps the SKU and the others get new ones (to confirm). Invalid SKUs like `AB-12` get new SKUs for every item. Why: one click for the common case.

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
