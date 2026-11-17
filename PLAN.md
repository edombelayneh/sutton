# PLAN

> Shared plan. **Either of us can edit this file.** Claude re-reads it before every step, so your edits win.

## Prompt
An operations admin at a warehouse is moving off spreadsheets. They need to bulk-import inventory items from a file **and trust what got in and what didn't**. Get a working importer first, then spend the rest of the hour making the import effortless: get a messy file in, fix what's wrong, and know exactly what got imported, all in the app. (Full schema: `samples/schema.json`.)

## Goal
The admin drops in a messy spreadsheet. The app maps the columns, fixes what's safe, lets them fix the rest inline, and shows exactly what will be imported and what was.

## Who the user is
An ops admin. Not a developer. Used to Excel. Wants confidence, not JSON.

## Decisions
- **Stack:** Vite + React + Tailwind (frontend) + Express (`server/`). One `npm run dev` starts both.
- **Existing records:** stored in a JSON file (`data/items.json`). SKU uniqueness is checked against the file **and** the store.
- **AI:** OpenRouter via `server/ai.js`, server-side only. Key in `.env` (`OPENROUTER_API_KEY`, never committed). The app works fully without a key; only the AI features turn off.
- **Validation lives in `shared/`**, so the browser gives instant feedback and the server re-checks on import (the server is the source of truth).

## What the messy file contains (profiled 200 rows)
| Problem | Example | Plan |
|---|---|---|
| Renamed, re-ordered and padded headers | `"SKU "`, `Item Name`, `Unit Cost ($)`, `Active?` | Auto-map |
| Extra column | `Internal Notes` | Ignore (not in schema) |
| SKU case and whitespace | `fxbu-khm`, `" YAKX-LG4"` | Auto-fix |
| Bad or missing SKU | `ab-12`, empty | User fixes |
| Duplicate SKUs | `FXBU-KHM` ×2 | User picks/fixes |
| Category as words | `Raw Material`, `Finished Good`, `Misc` | Auto-fix words; `Misc` → user |
| UoM case | `ea` | Auto-fix |
| Cost formats | `$23.98`, `0,26`, `TBD`, `-2.9` | Strip `$` and comma decimals; `TBD` and negatives → user |
| Qty formats | `1,200`, `12.5` | `1,200` → 1200; `12.5` → user |
| Booleans | `1`, `yes`, `TRUE`, `maybe` | Auto-fix; `maybe` → user |
| Dates | `05/07/2024`, `Jan 7, 2024` | Convert to YYYY-MM-DD (flag ambiguous ones) |
| Names with padding / empty | `"  Oak Tool Cart "` | Trim; empty → user |
| Tags case/dupes | `Metal;metal; METAL` | Lowercase and dedupe |
| Discontinued but active | `NFQN-X23` | User (or suggest `is_active=false`) |
| Broken vendor JSON / >1 preferred | truncated JSON | User |
| Dimensions missing height | `{length,width}` | User |
| Multi-line descriptions | 2 rows | Parser handles |

## Core user flow
1. **Upload**: drag and drop a CSV (or click "try a sample").
2. **Map columns**: auto-mapped, with a dropdown to override; unknown columns are ignored.
3. **Review & fix**: a table with per-cell errors, inline editing and an "errors only" filter.
4. **Import**: a clear summary ("182 will import, 18 blocked") → import the valid rows.
5. **Results**: what got in and what didn't (and why), with a download of the rejected rows.

## Tasks
### Phase 1: Make it work
- [x] Shared schema validation (all field rules + cross-row rules)
- [x] Express API: `GET /api/items`, `POST /api/import`, `DELETE /api/items`, JSON store
- [x] Frontend: Upload → Map → Review/Fix → Import → Results
- [ ] Test with the clean + messy samples

### Phase 2: Make it effortless
- [x] Auto-fix safe issues + a "what we changed" before → after view
- [x] Duplicate SKU resolver (Keep / New SKU / Skip / Resolve all)
- [x] AI header mapping fallback
- [x] AI suggestions for remaining errors (one-click accept)
- [x] Download rejected rows as CSV (done in Phase 1)

### Phase 3: Make it pretty (motionsites, only when you say go)
- [ ] _TBD_

### Phase 4: Ship
- [ ] Update README, FEATURES, CHANGELOG
- [ ] `npm run zip` and submit (submit early and often)

## Time checkpoints
| Time | Target |
|------|--------|
| T+0  | Prompt received, plan filled in ✅ |
| T+20 | Phase 1 working end to end, **first zip submitted** |
| T+40 | Phase 2 auto-fix + inline fix polished |
| T+50 | Beautify with motionsites |
| T+55 | Final docs + final zip |
| T+60 | Timer ends (5-minute upload window only) |

## Open questions / notes
- _Add anything here._
