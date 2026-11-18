# Improvements

Gaps I wish I had covered in the first version, and what we're doing about them.
New entries are added only after the owner approves them.

| # | Gap | Why it matters | Status |
|---|-----|----------------|--------|
| 1 | No login | Anyone who can open the app can import, edit or delete inventory, and nothing records who did it | Planned |
| 2 | No "imported by" record | You can't tell who imported a batch or filter imports by employee | Planned (needs #1) |
| 3 | Multi-file uploads repeat headers and drop data | Headers are merged only when the text matches exactly, so `SKU`, `SKU ` and `sku` show up as separate rows on the Map step. Only one of them gets mapped to the SKU field, so the **other files' rows lose their SKU values** | Done |
| 4 | Data is stored in JSON files | A JSON file doesn't scale, has no real queries or relations, and can't safely handle several users at once. Employees (#1) and audit data (#2) make this more pressing | Planned (decide first) |
| 5 | No automated tests | Bugs like the multi-file SKU loss (#3) went unnoticed because nothing checks behavior automatically. Every change risks breaking import, auto-fix or validation without anyone knowing | Planned |

---

## 1. Login (real auth)
- Employees sign in with **email or employee ID + password**.
- Credentials are checked against a stored employee table. Passwords are hashed (Node's built-in `scrypt`), never stored as plain text.
- The server creates a session (httpOnly cookie). Every `/api/*` route except login requires a session.
- There's a seed script for the first employees, because there is no sign-up page.
- Until #4 is decided, employees live in `data/employees.json`, and they move to the database along with everything else.

## 2. Imported by + filter
- Each batch and each item records `imported_by: { id, name }`, taken from the session on the server (never trusted from the browser).
- Edits record `updated_by` the same way.
- The Imported items page gets an "Imported by" column, plus a filter that searches by employee name or ID.

## 3. Consistent headers across multiple files
- **Root cause:** in `src/App.jsx` (`loadFiles`), headers are deduped by exact text. Then `autoMapHeaders` in `shared/schema.js` lets only one header claim each field, so a second file's `SKU ` stays unmapped.
- **Fix:** group look-alike headers (case, spacing, `_`/`-`) into one column. The Map step shows each column once, listing the files it comes from and how each one spells it. Differently named columns (`SKU` vs `Item Code`) stay as separate rows, but they can all map to the same field.
- Every row maps through its own file's header, so all files contribute data to the same field.
- Two files having different headers for the same field (for example `SKU` and `Item Code`) also works.
- **Merging happens in three levels, cheapest first:**
  1. **Same spelling** (ignoring case and spacing): `SKU`, `SKU `, `sku`.
  2. **Same field by alias:** `SKU` in one file and `Item Code` in another.
  3. **AI:** for anything left over, the AI compares headers *and* sample values across files (`Part #` = `SKU`, `Grp` = `Category`, `Date Out` = `Discontinued On`), and the server double-checks every answer.
- Two columns from the **same file** never merge. Every merge is shown on the Map step: ✓ green for our own checks, 🤖 purple for AI.
- **Done:** `combineFiles`, `autoMapColumns`, `mergeByField` and `mergeColumns` in `shared/schema.js`, plus `same_as` in `/api/ai/map`. On messy + odd-headers together: 29 columns → 16, and both files' SKUs come through.

## 4. Database: PostgreSQL vs GraphQL (to discuss)
These aren't alternatives. **PostgreSQL is a database** (it replaces the JSON files). **GraphQL is an API style** (it replaces the REST routes, and it still needs a database behind it).

| Option | Pros | Cons |
|--------|------|------|
| Keep JSON files | Nothing new to learn, zero setup | Rewrites the whole file on every save, no concurrent writes, no queries or joins, doesn't scale |
| PostgreSQL + current REST API | Real transactions (import and undo stay all-or-nothing), unique SKU enforced by the DB, fast filtering (e.g. by employee), foreign keys between items, batches and employees, industry standard | Needs a running Postgres server (or Docker), adds migrations |
| SQLite + current REST API | Most of the Postgres benefits with no server (it's a single file), easiest move from JSON | Weaker under many writers at once, and you'd likely move to Postgres later |
| PostgreSQL + GraphQL | Clients ask for exactly the fields they need, one typed schema | Much more setup (schema, resolvers), and our few simple endpoints don't need it. Mostly cost for little gain here |

**Leaning:** PostgreSQL with the existing REST API. To be decided together before building.

## 5. Automated tests
- **Why:** the multi-file bug (#3) silently dropped SKUs, and only a manual check caught it. Tests would have caught it on the first run.
- **Plan:** Vitest (it fits with Vite, so there's nothing extra to configure). Run with `npm test`.
- **Cover first:** the pure logic in `shared/` (header mapping, `combineFiles`, validation, auto-fix) using the sample files, then the API routes (import, undo, update, and auth once #1 lands).
- Every bug we fix gets a test that would have caught it.
