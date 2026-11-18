-- Employees who can sign in, and their sessions.

CREATE TABLE employees (
  id            serial PRIMARY KEY,
  employee_id   text NOT NULL,                -- e.g. E1001, what people type to sign in
  email         text NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  password_hash text NOT NULL,                -- scrypt, never the password itself
  active        boolean NOT NULL DEFAULT true, -- set false to block sign-in without deleting history
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Sign-in ignores case for both, so uniqueness does too.
CREATE UNIQUE INDEX employees_employee_id ON employees (lower(employee_id));
CREATE UNIQUE INDEX employees_email ON employees (lower(email));

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,               -- sha256 of the cookie token; a DB leak can't be replayed
  employee_id integer NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_employee ON sessions (employee_id);
