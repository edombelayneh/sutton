# Sutton: Inventory Import

A local web app that lets a warehouse operations admin bulk-import inventory items from a messy spreadsheet. It maps the columns, fixes what's safe to fix, helps them fix the rest **without going back to Excel**, and shows exactly what got in and what didn't.

## Run it locally

Requirements: **Node.js 20.19+ or 22.12+** (Vite 8's minimum; tested on Node 25), npm, and **PostgreSQL** (tested on 18).

```bash
brew install postgresql@18             # once (macOS; any Postgres works)
brew services start postgresql@18      # keeps it running in the background
createdb sutton                        # once
npm install
npm run employee -- add --id E1001 --name "Your Name" --email you@company.com   # once: asks for a password
npm run dev
```

**Run the tests:** `npm test` (60 tests, about 3 seconds). They use a separate `sutton_test` database, created automatically, and never touch your data or call the AI.

Sign in with your **email or employee ID** and the password you chose. There's no sign-up page: add, reset or block people with `npm run employee -- add | password <id> | deactivate <id> | activate <id> | list` (see `server/employees.js`).

The server creates its tables on startup (`migrations/*.sql`). To use a different database, set `DATABASE_URL` in `.env` (default `postgres://localhost/sutton`).

This starts the web app and the API together. The browser opens **http://localhost:5173** (the API is on port 3001).

**Try it in 10 seconds:** click **Messy sample** on the first screen, then **Continue**.

### Optional: turn on AI

```bash
cp .env.example .env
# then edit .env:  GROQ_API_KEY=gsk_...
# optional:        AI_MODEL=<any Groq model id>   (default: openai/gpt-oss-120b)
```

Restart `npm run dev` after adding the key. **Without a key everything works**; only the two AI helpers (column matching for odd headers and "Ask AI to fix") are turned off.

## What it does

**1. Upload.** Drag in one or more **CSV or Excel** files (several files are reviewed as one batch, with cross-file duplicate checks), or use the sample files. Multi-line descriptions and quoted commas are handled.

**2. Map columns.** Headers are matched automatically, even when they're renamed or padded (`"SKU "`, `Unit Cost ($)`, `Active?`, `Reorder Pt`). Columns we can't match are sent to the AI with sample values (e.g. `Part #`, `Grp`, `Std Cost`); each AI pick is labeled and can be changed. Columns that aren't item fields (e.g. `Internal Notes`) are ignored.

**3. Review & fix.** This is where most of the work went.
- **Safe auto-fixes**, all shown and undoable: SKU case/spaces, `$` signs, comma decimals (`0,26`), thousands separators (`1,200`), `yes`/`1`/`TRUE` → `true`, dates (`Jan 7, 2024` → `2024-01-07`), category words (`Raw Material` → RAW), tag case and duplicates. On the messy sample this takes valid rows from **139 → 165 of 200** with no clicks.
- **Guesses must be confirmed**: ambiguous dates like `05/07/2024` are converted as US dates but flagged for a check, so we never import a guess silently.
- **Duplicate SKUs**: the messy file's duplicates are *different products* sharing a SKU, so we never blindly merge them. Per row you can *Keep SKU*, get a generated *New SKU* (valid and unique, e.g. `FIBE-7K2`), or *Skip*. Truly identical rows can be removed. *Resolve all* does it in one click. SKUs that already exist in the system go through the same flow, plus an **Update the existing item** option for re-imports.
- **Ask AI to fix** the remaining rows (e.g. `TBD` cost → the preferred vendor's cost, `Misc` category → inferred from the name, repairing truncated vendor data). Every suggestion is purple and needs *Keep*. Nothing AI-made imports without approval.
- **A readable list, not a spreadsheet**: categories and units in words, `$` and thousands formatting, and a plain-English *"What's going on"* column. Click a row to open an **edit panel** with grouped fields. **No JSON is shown anywhere**: size is L × W × H plus a unit, and vendors are an editable list with a ★ for the one preferred vendor.
- **Color = source of change**: 🟢 safe fix · 🟡 our guess · 🟣 AI · 🟠 duplicate · 🔴 needs you. Filter chips (*Needs attention*, *Duplicates*, *AI*, *Auto-fixed*, *All*) and a live "162 of 200 ready" bar show how close you are.

**4. Import & results.** Only valid, confirmed rows import (partial import is intentional). The server **re-validates everything**. The results page leads with *"N items are in."*, lists what didn't import and why, offers **Download as CSV** of the rejected rows, and has **Undo this import** (removes what it added and restores anything it updated).

**Imported items.** A full-screen, searchable list of everything already in the system. Click an item to see all its details, **edit** it (re-validated with the same rules) or **delete** it (with a confirm). **Clear all** empties the store (confirmed). The **Upload history** tab lists every upload; **↶ Restore to before this** puts the inventory back exactly as it was before any of them. Header steps and the logo take you back, and ask first if you'd lose edits.

## How it's built

| Piece | Where | Notes |
|---|---|---|
| Validation rules | `shared/schema.js` | One module used by **both** the browser (instant feedback) and the server (source of truth). All field rules plus cross-row rules (unique SKU in the file *and* the store, ≤ 1 preferred vendor, discontinued ⇒ inactive). |
| Safe auto-fixes | `shared/autofix.js` | Deterministic; each fix records `from`, `to`, `why` and whether it's a guess. Also the SKU generator. |
| API + store | `server/index.js` | Express. `GET/DELETE /api/items`, `POST /api/import`, `POST /api/import/:batch/undo`, `GET /api/batches`, `POST /api/batches/:id/restore`, `PUT/DELETE /api/items/:sku`, `POST /api/ai/map`, `POST /api/ai/suggest`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. **Every route except sign-in and `/api/health` needs a signed-in employee** (`server/auth.js`). Items are stored in **PostgreSQL** (`server/db.js`, schema in `migrations/`). Each import and each undo runs as **one transaction**, and the database also enforces the schema rules (SKU format, categories, cost ≥ 0, discontinued ⇒ inactive, unique SKU). The API listens on **127.0.0.1 only**. |
| AI client | `server/ai.js` | A small Groq client (OpenAI-compatible). Called **only from the server**, so the key never reaches the browser. |
| UI | `src/App.jsx`, `src/review-ui.jsx` | React + Tailwind v4. |
| Samples | `samples/`, `public/samples/` | `items_clean.csv`, `items_messy.csv`, `items_odd_headers.csv` (for AI header matching), `schema.json`. |

Stack: **Vite + React + Tailwind v4 + Express**. Data lives in **PostgreSQL** (plain SQL through `pg`, no ORM).

## What works / what doesn't yet

**Works and tested:** the full flow on both samples. Validation of every schema rule; auto-fixes (the clean file gets 0 changes, as it should); the duplicate resolver; partial import with server re-validation; SKUs already in the store are caught; rejected-rows CSV; imported-items search, edit and delete; back navigation.

**Known gaps:**
- **AI quality depends on the model.** The default is `openai/gpt-oss-120b` on Groq; set `AI_MODEL` to try another. AI suggestions are always gated behind *Keep*, so a bad suggestion can't import on its own.
- **Undo covers whole imports only**; manual edits in Imported items aren't versioned (`updated_at` is recorded).
- **Excel: first sheet only.** Updating an existing item shows a chip, not a field-by-field before → after diff yet.
- **Ambiguous dates** assume US `MM/DD/YYYY` (flagged for the user to confirm); there's no locale setting.
- **Large files**: the review list renders every row in the current filter. It's fine at hundreds of rows; thousands would need virtualization.
- **Security:** there's no login; the API is bound to localhost so only this machine can reach it. Rejected-rows CSV exports are formula-safe, and the Excel parser is the patched SheetJS 0.20.3.
- **Ask AI** sends at most 200 rows per request (ask again for more).
- No automated test suite yet; testing was by script checks against the samples plus hands-on browser testing (see below).

## How we worked

Built in one hour, pairing with **Claude Code** (Claude Opus 5.5) as the agent:

- **Plan first, in shared docs.** Before the timer started we set up the repo, stack, docs and a zip script. When the prompt arrived, the agent **profiled the messy file** (every problem type, with counts) and wrote [PLAN.md](PLAN.md) before writing any code. PLAN.md is shared: I could edit it, and the agent re-read it each step.
- **Confirm before acting.** The agent proposed each change and waited for a go-ahead, and asked before every commit and push. Each turn was time-boxed to 10 minutes.
- **Working first, then effortless, then pretty.** Phase 1 was a working importer, Phase 2 cut the admin's effort (auto-fix → duplicates → AI), and Phase 3 was the design (using the *motionsites* skill, then a redesign for clarity).
- **Hands-on testing drove the changes.** Many commits came from me clicking through the app: rows vanishing mid-typing, fixes too subtle and mixed with red, duplicate cards that wouldn't scale, AI colors not matching, JSON on screen. The agent also checked its own work with screenshots in a browser pane, which caught a panel rendering under the header.
- **Look at the data before designing.** The duplicate resolver changed from "merge" to "give one a new SKU" after the agent saw that every duplicate pair was two different products.
- **Commit as we go, ship early.** There are small commits with reasons, and the zip was rebuilt and submitted after each phase. [CHANGELOG.md](CHANGELOG.md) records *what changed and why* for every step, and [FEATURES.md](FEATURES.md) says why each feature helps the admin.

## Project docs

| File | Purpose |
|------|---------|
| [PLAN.md](PLAN.md) | Shared plan: goal, data profile, user flow, tasks, time checkpoints |
| [FEATURES.md](FEATURES.md) | Each feature and why it helps the user |
| [CHANGELOG.md](CHANGELOG.md) | What we changed and why, newest first |

## Submitting

```bash
npm run zip
```

Creates `../sutton-submission.zip` with the source and the `.git` folder. It leaves out `node_modules`, `dist` and `.env` (your API key).
