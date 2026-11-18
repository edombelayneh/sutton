# Improvements

Gaps I wish I had covered in the first version, and what we're doing about them.
New entries are added only after the owner approves them.

| # | Gap | Why it matters | Status |
|---|-----|----------------|--------|
| 1 | No login | Anyone who can open the app can import, edit or delete inventory, and nothing records who did it | Done |
| 2 | No "imported by" record | You can't tell who imported a batch or filter imports by employee | Done |
| 3 | Multi-file uploads repeat headers and drop data | Headers are merged only when the text matches exactly, so `SKU`, `SKU ` and `sku` show up as separate rows on the Map step. Only one of them gets mapped to the SKU field, so the **other files' rows lose their SKU values** | Done |
| 4 | Data is stored in JSON files | A JSON file doesn't scale, has no real queries or relations, and can't safely handle several users at once. Employees (#1) and audit data (#2) make this more pressing | Done |
| 5 | No automated tests | Bugs like the multi-file SKU loss (#3) went unnoticed because nothing checks behavior automatically. Every change risks breaking import, auto-fix or validation without anyone knowing | Done |
| 6 | No way back to an earlier upload | "Undo this import" only existed on the results page right after importing. Once you left, a bad upload (or the edits after it) couldn't be rolled back | Done |
| 7 | No way to export what got in | "Know exactly what got imported" was only a list of SKUs. The admin couldn't take the result back to their spreadsheet to check it | Done |

---

## 1. Login (real auth)
- Employees sign in with **email or employee ID + password**.
- Credentials are checked against a stored employee table. Passwords are hashed (Node's built-in `scrypt`), never stored as plain text.
- The server creates a session (httpOnly cookie). Every `/api/*` route except login requires a session.
- There's a seed script for the first employees, because there is no sign-up page.
- Employees live in an `employees` table in PostgreSQL (#4 is done).
- **Done:**
  - `migrations/003_auth.sql`: `employees` and `sessions` tables. Email and employee ID are unique regardless of case.
  - `server/auth.js`: scrypt password hashes; a random 256-bit session token in an `HttpOnly; SameSite=Lax` cookie, lasting 12 hours; the database stores only a SHA-256 of each token.
  - The same "wrong email/ID or password" message whether or not the account exists, with equal timing.
  - Lockout after 5 failed attempts per account for 15 minutes (plus a 100-failure overall cap). Not per IP, because behind the Vite proxy everyone shares 127.0.0.1.
  - `npm run employee -- add | password | deactivate | activate | list`. Passwords are typed at a hidden prompt. Changing a password or deactivating someone signs them out everywhere.
  - App: sign-in screen; name and **Sign out** in the header; if a session expires, you're returned to sign-in with a note.
  - Tested: 27 auth checks (every route locked, ID/email sign-in, logout, forged/expired tokens, lockout, deactivate) plus the 33 existing checks while signed in.
- **Not yet:** no password reset by email (an admin runs `npm run employee -- password <id>`), and no HTTPS, so keep it on localhost until it's deployed behind TLS.

## 2. Imported by + filter
- Each batch and each item records `imported_by: { id, name }`, taken from the session on the server (never trusted from the browser).
- Edits record `updated_by` the same way.
- The Imported items page gets an "Imported by" column, plus a filter that searches by employee name or ID.
- **Done:**
  - `migrations/004_imported_by.sql`: `imported_by` on uploads and items, `updated_by` on items, `changed_by` on every change-log entry.
  - The server sets these from the signed-in session. Anything the browser sends for them is ignored (tested).
  - Editing keeps the original importer and records the editor. Restoring to before an upload brings back who imported or edited each item, too.
  - **Imported items:** "Imported by" column, an **Imported by: Everyone / name (ID)** filter, and a search box that also matches employee name or ID. Item details show **Imported by** and **Last edited … by …**.
  - **Upload history:** "By" column and an **Uploaded by** filter.
  - Items imported before this change show "–".

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

**Decision:** PostgreSQL with the existing REST API, plain SQL through `pg` (no ORM), starting with an empty database.

**Done:**
- Tables `items`, `import_batches` and `batch_previous` (what an import replaced, so undo can restore it), in `migrations/001_init.sql`. Migrations run automatically on server start.
- The database enforces the schema rules too: SKU format, unique SKU, category and unit lists, cost ≥ 0, whole-number quantities, discontinued ⇒ inactive.
- Each import and each undo is one transaction (all or nothing), and imports run one at a time, so two people importing the same new SKU at once can't both get in.
- Tested with 20 API checks against a separate `sutton_test` database.

## 5. Automated tests
- **Why:** the multi-file bug (#3) silently dropped SKUs, and only a manual check caught it. Tests would have caught it on the first run.
- **Plan:** Vitest (it fits with Vite, so there's nothing extra to configure). Run with `npm test`.
- **Cover first:** the pure logic in `shared/` (header mapping, `combineFiles`, validation, auto-fix) using the sample files, then the API routes (import, undo, update, and auth once #1 lands).
- Every bug we fix gets a test that would have caught it.
- **Done:** `npm test` (Vitest) runs the tests in about 3 seconds (69 as of #7):
  - `tests/unit/columns.test.js`: column mapping and multi-file merging, including the regression test for #3 (the second file losing its SKUs).
  - `tests/api/items.test.js`: import, update, edit, delete, clear all, simultaneous imports, and the rules the database enforces.
  - `tests/api/history.test.js`: undo and "restore to before", including the regression test for items left behind after a restore.
  - `tests/api/auth.test.js`: every route locked, sign-in by ID or email, cookies, logout, expiry, deactivate, lockout.
  - `tests/api/imported-by.test.js`: who imported, edited and deleted, with fake values from the browser ignored.
  - `tests/api/employees-cli.test.js`: the `npm run employee` script.
- API tests start the real server on a random port against **`sutton_test`**. They refuse to run against any database whose name doesn't end in `_test`, and they never call the real AI.
- **Not covered yet:** the React screens (that would need browser tests, e.g. Playwright), and the AI prompts themselves.

## 6. Upload history + "Restore to before this"
- **Imported items → Upload history** tab lists every upload, newest first: when, which files, how many were added, updated and not imported.
- **↶ Restore to before this** puts the inventory back **exactly** as it was before that upload. That upload, every later upload, and any edits or deletes made since are all undone, in one transaction. The confirm dialog says what else will be undone.
- **How:** an `item_changes` log (`migrations/002_change_log.sql`) records every change to an item (import, update, edit, delete, rename) with its before and after values. Restoring replays it backwards. This replaced the old `batch_previous` table, so "Undo this import" on the results page uses the same mechanism.
- Ready for "imported by" (#2): each upload row can show who did it.
- Tested: 3 uploads, then an edit, a delete and a rename, then restore to before upload 2 → items identical to right after upload 1.

## 7. Export what got in
- **Results page:** a "What got in" card with **Download exactly what was saved: CSV · JSON**, holding just the items this import saved.
- **Imported items:** **Download all / Download these** (respects the search and Imported by filter): CSV · JSON.
- **CSV** uses the brief's encoding (schema columns, `;` tags, `true`/`false`, JSON cells), so an exported file **imports back unchanged** (tested end to end). **JSON** is the brief's canonical shape (nested objects and arrays, schema fields only).
- Text cells that would run as spreadsheet formulas get a leading `'`, like the rejected-rows download.
- **Choose columns:** **Download…** opens a panel to pick CSV or JSON and which columns: any schema field, plus audit columns (Imported by/at, Last edited by/at). Shortcuts: All / Item fields only / None. The choice is remembered for next time. If a required field is left out, the panel warns that the file can't be imported back as is.
