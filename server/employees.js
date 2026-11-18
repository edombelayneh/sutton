// Manage who can sign in. There's no sign-up page on purpose: an admin adds people here.
//
//   npm run employee -- add --id E1001 --name "Dana Lee" --email dana@company.com
//   npm run employee -- password E1001        (set a new password)
//   npm run employee -- deactivate E1001      (block sign-in, keep their history)
//   npm run employee -- activate E1001
//   npm run employee -- list
//
// Passwords are typed at a hidden prompt (never on the command line, so they don't land in shell history).
// For scripts/tests only: set EMPLOYEE_PASSWORD to skip the prompt.
import 'dotenv/config'
import readline from 'node:readline'
import { pool, migrate } from './db.js'
import { hashPassword, passwordProblem } from './auth.js'

const [cmd, ...rest] = process.argv.slice(2)
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }
const fail = (msg) => { console.error(msg); process.exitCode = 1 }

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s) } // don't echo what's typed
    rl.question(question, (answer) => { rl.output.write('\n'); rl.close(); resolve(answer) })
  })
}
async function newPassword() {
  const fromEnv = process.env.EMPLOYEE_PASSWORD
  if (fromEnv !== undefined) {
    const problem = passwordProblem(fromEnv)
    if (problem) throw new Error(problem)
    return fromEnv
  }
  for (;;) {
    const p = await askHidden('Password (min 8 characters): ')
    const problem = passwordProblem(p)
    if (problem) { console.log(problem); continue }
    if (await askHidden('Repeat password: ') === p) return p
    console.log("Passwords don't match, try again.")
  }
}
const findOne = async (login) =>
  (await pool.query('SELECT * FROM employees WHERE lower(employee_id) = lower($1) OR lower(email) = lower($1)', [login])).rows[0]

try {
  await migrate()
  if (cmd === 'add') {
    const id = flag('id')?.trim(), name = flag('name')?.trim(), email = flag('email')?.trim()
    if (!id || !name || !email) fail('Usage: npm run employee -- add --id E1001 --name "Dana Lee" --email dana@company.com')
    else if (!/^[A-Za-z0-9_-]{2,32}$/.test(id)) fail('Employee ID: 2-32 letters, digits, - or _')
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('That email address looks wrong')
    else if (await findOne(id) || await findOne(email)) fail('An employee with that ID or email already exists')
    else {
      const hash = await hashPassword(await newPassword())
      await pool.query('INSERT INTO employees (employee_id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [id, email, name, hash])
      console.log(`Added ${name} (${id}, ${email}). They can sign in with either the ID or the email.`)
    }
  } else if (cmd === 'password' || cmd === 'deactivate' || cmd === 'activate') {
    const emp = rest[0] && await findOne(rest[0])
    if (!emp) fail(`No employee "${rest[0] ?? ''}". Usage: npm run employee -- ${cmd} <employee ID or email>`)
    else if (cmd === 'password') {
      await pool.query('UPDATE employees SET password_hash = $2 WHERE id = $1', [emp.id, await hashPassword(await newPassword())])
      await pool.query('DELETE FROM sessions WHERE employee_id = $1', [emp.id]) // sign them out everywhere
      console.log(`Password changed for ${emp.name}. Their open sessions were signed out.`)
    } else {
      await pool.query('UPDATE employees SET active = $2 WHERE id = $1', [emp.id, cmd === 'activate'])
      if (cmd === 'deactivate') await pool.query('DELETE FROM sessions WHERE employee_id = $1', [emp.id])
      console.log(`${emp.name} is now ${cmd === 'activate' ? 'active' : 'deactivated (signed out, cannot sign in)'}.`)
    }
  } else if (cmd === 'list') {
    const { rows } = await pool.query('SELECT employee_id, name, email, active FROM employees ORDER BY employee_id')
    if (!rows.length) console.log('No employees yet. Add one with: npm run employee -- add --id E1001 --name "..." --email ...')
    for (const e of rows) console.log(`${e.employee_id.padEnd(10)} ${e.name.padEnd(24)} ${e.email}${e.active ? '' : '  (deactivated)'}`)
  } else {
    fail('Commands: add, password, deactivate, activate, list. See the top of server/employees.js.')
  }
} catch (e) {
  fail(e.code === 'ECONNREFUSED' ? "Can't reach the database. Is Postgres running? (brew services start postgresql@18)" : String(e.message || e))
} finally {
  await pool.end()
}
