# Features

Each feature, why it helps the user, and its status.

| # | Feature | Why it helps the user | Status |
|---|---------|----------------------|--------|
| 1 | Drag-and-drop CSV upload + sample files | Gets them started with no instructions to read | Done |
| 2 | Automatic column mapping (with override dropdowns + example values) | Their spreadsheet headers never match ours; no renaming columns in Excel | Done |
| 2b | 🤖 AI fallback for columns we can't match (uses header + sample values) | Even unusual spreadsheets map without manual work; each AI pick is labeled and can be overridden | Done (needs key) |
| 3 | Per-cell validation with plain-English errors | They see exactly what's wrong and where, not a wall of JSON errors | Done |
| 4 | Inline editing in the review table | Fix problems in the app instead of going back to the spreadsheet | Done |
| 5 | "Needs attention" filter | Focus on the 20 bad rows, not 200 rows | Done |
| 6 | Duplicate SKU check (in the file and against existing items) | Prevents silently overwriting or double-counting stock | Done |
| 7 | Import only valid rows; hold back the rest with reasons | One bad row doesn't block the whole import; they trust what got in | Done |
| 8 | Results page + download of the rows that weren't imported (with reasons) | They know exactly what got in and have a to-do list for the rest | Done |
| 9 | Auto-fix safe issues (casing, $, comma decimals, dates, yes/no, tags, category words) | Removes the tedious Excel cleanup: 26 more rows import with zero effort | Done |
| 9b | Before → after on every fixed cell, with undo and an "Auto-fixed" filter | They can see and reverse every change we made, so they trust the result | Done |
| 9d | Row status column (Ready / Check fixes / Needs you) + Keep/Undo + "Confirm all" | Every row says exactly what to do next; one click accepts all our fixes | Done |
| 9c | Ambiguous dates flagged amber "please double-check" | We never hide an assumption that could be wrong | Done |
| 9e | Duplicate SKU banner + "Duplicates" filter: Keep / ✨ New SKU / Skip inline, remove identical copies, Resolve all | They know duplicates exist and fix them without losing a real product, and it scales to any file size | Done |
| 13 | Readable list: words not codes, $ and thousands formatting, plain-English "What's going on" chips | The admin understands every row at a glance, without knowing the schema | Done |
| 14 | Slide-in edit panel with grouped fields, Next issue / ↑↓ navigation | Fix rows one at a time with full context, fast | Done |
| 15 | No JSON on screen: size as L×W×H + unit, vendors as an editable list with ★ preferred; recovers truncated vendor data | Non-technical users can edit complex fields safely | Done |
| 16 | Clickable steps / logo to go back (with a "lose changes?" confirm) | Move around freely without losing work by accident | Done |
| 17 | Searchable "Imported items" view; click an item for details, then Edit (re-validated) or Delete (confirmed) | See and verify everything already in the system, field by field | Done |
| 18 | Excel upload + multiple files as one batch (with source file + cross-file duplicate check) | Upload what they actually have, all at once | Done |
| 19 | Update existing items instead of rejecting them | Re-imports (e.g. new stock counts) just work | Done |
| 20 | Undo this import (restores updated items too) | Mistakes are reversible, so importing feels safe | Done |
| 21 | "Clear all" imported items (confirmed) | Start fresh for a new system or a demo in one click | Done |
| 22 | Safe by default: localhost-only API, atomic saves, formula-safe CSV export, patched Excel parser | Their data can't be lost to a crash or exposed on the network | Done |
| 11 | Live import-health bar + "N/200 ready" counter | Instantly shows how close they are to done | Done |
| 12 | Guided upload page (Map / Fix / Trust explainer, sample files) | They know what will happen before uploading | Done |
| 10b | Color-coded sources (purple AI, green fixed, amber guess, orange duplicate, red needs you) + "🤖 AI" filter + Accept all | The admin can tell at a glance who changed what, and review AI work in bulk | Done |
| 10 | 🤖 AI suggestions for remaining errors (category from name, cost from vendor, repair JSON, …), each one Keep/Undo | Does the tedious judgment-call work for them, but never imports anything they haven't approved | Done (needs `GROQ_API_KEY`) |
| 23 | Multi-file uploads: one Map row per field, so every file's matching column (`SKU`, `SKU `, `Item Code`…) feeds the same field | No duplicate headers, and no file silently loses its data | Done |
| 24 | Sign in with email or employee ID + password, checked against stored employees | Only real employees can change inventory | Done |
| 25 | "Imported by" on every batch and item + filter by employee name or ID | They know who imported what and can review one person's work | Planned |
| 27 | Upload history tab + "↶ Restore to before this" on any past upload (undoes it, later uploads and later edits, exactly) | A bad upload is never permanent, even days later | Done |
| 26 | Move storage from JSON files to a database (PostgreSQL vs alternatives, see IMPROVEMENTS.md) | Safe multi-user saves, fast filtering, a foundation for logins and audit data | Done (PostgreSQL) |

**Status key:** Planned · In progress · Done · Cut (with reason)
