// User accounts. Passwords are hashed with Bun.password (argon2id); the hash
// never leaves this module.

import { sqlite, uid } from "../db";

export type Role = "operator" | "admin" | "agent";
export type Presence = "available" | "busy" | "away" | "offline";

export const ROLES: Role[] = ["operator", "admin", "agent"];
export const PRESENCES: Presence[] = ["available", "busy", "away", "offline"];
export const MIN_PASSWORD_LENGTH = 8;

/** What the API returns — no password hash. */
export interface User {
  id: string;
  orgId: string | null;
  email: string;
  name: string;
  role: Role;
  presence: Presence;
  createdAt: number;
  lastLoginAt: number | null;
}

interface UserRow {
  id: string;
  org_id: string | null;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  presence: Presence;
  created_at: number;
  last_login_at: number | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  orgId: r.org_id,
  email: r.email,
  name: r.name,
  role: r.role,
  presence: r.presence,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
});

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function countUsers(): number {
  return sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n;
}

export function getUser(id: string): User | null {
  const r = sqlite.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id);
  return r ? toUser(r) : null;
}

export function listUsers(orgId: string): User[] {
  return sqlite.query<UserRow, [string]>(
    "SELECT * FROM users WHERE org_id = ? ORDER BY role, name COLLATE NOCASE",
  ).all(orgId).map(toUser);
}

export async function createUser(u: {
  orgId: string | null; email: string; name: string; password: string; role: Role;
}): Promise<User> {
  const id = uid();
  sqlite.query(`
    INSERT INTO users (id, org_id, email, name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, u.orgId, normaliseEmail(u.email), u.name.trim(), await Bun.password.hash(u.password), u.role, Date.now());
  return getUser(id)!;
}

const DUMMY_HASH = await Bun.password.hash("not-a-real-password");

/** The user for these credentials, or null. Always runs one hash
 *  verification, so a wrong email and a wrong password take the same time. */
export async function verifyLogin(email: string, password: string): Promise<User | null> {
  const r = sqlite.query<UserRow, [string]>("SELECT * FROM users WHERE email = ?").get(normaliseEmail(email));
  const ok = await Bun.password.verify(password, r?.password_hash ?? DUMMY_HASH);
  return r && ok ? toUser(r) : null;
}

export async function updateUser(id: string, patch: {
  name?: string; role?: Role; password?: string; presence?: Presence;
}) {
  if (patch.name !== undefined) sqlite.query("UPDATE users SET name = ? WHERE id = ?").run(patch.name.trim(), id);
  if (patch.role !== undefined) sqlite.query("UPDATE users SET role = ? WHERE id = ?").run(patch.role, id);
  if (patch.presence !== undefined) sqlite.query("UPDATE users SET presence = ? WHERE id = ?").run(patch.presence, id);
  if (patch.password !== undefined) {
    sqlite.query("UPDATE users SET password_hash = ? WHERE id = ?").run(await Bun.password.hash(patch.password), id);
  }
  return getUser(id);
}

/** Who incoming calls should ring right now: the organisation's available
 *  people, or everyone available when the number belongs to no organisation. */
export function availableUserIds(orgId: string | null): string[] {
  if (orgId === null) {
    return sqlite.query<{ id: string }, []>("SELECT id FROM users WHERE presence = 'available'").all().map((r) => r.id);
  }
  return sqlite.query<{ id: string }, [string]>("SELECT id FROM users WHERE presence = 'available' AND org_id = ?")
    .all(orgId).map((r) => r.id);
}

export function markLoggedIn(id: string) {
  sqlite.query("UPDATE users SET last_login_at = ?, presence = 'available' WHERE id = ?").run(Date.now(), id);
}

export function deleteUser(id: string) {
  sqlite.query("DELETE FROM users WHERE id = ?").run(id);
}
