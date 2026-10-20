// Cookie sessions. The browser holds a random token; the database holds only
// its SHA-256, so the sessions table can't be replayed if it leaks.

import { sqlite } from "../db";
import { getUser, type User } from "./users";

export const SESSION_COOKIE = "sid";
const SESSION_DAYS = 14;

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 86_400_000;
  sqlite.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), userId, now, expiresAt);
  // Expired rows are useless; clear them out while we're writing anyway.
  sqlite.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return { token, expiresAt };
}

export function userForToken(token: string | null): User | null {
  if (!token) return null;
  const row = sqlite.query<{ user_id: string }, [string, number]>(
    "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
  ).get(hashToken(token), Date.now());
  return row ? getUser(row.user_id) : null;
}

export function deleteSession(token: string | null) {
  if (token) sqlite.query("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

/** Signs a user out everywhere — after a password reset or role change. */
export function deleteSessionsOf(userId: string, exceptToken?: string | null) {
  if (exceptToken) {
    sqlite.query("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, hashToken(exceptToken));
  } else {
    sqlite.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export function sessionToken(req: Request): string | null {
  const cookies = req.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=") || null;
  }
  return null;
}

/** Secure only over HTTPS (directly or behind a tunnel), so plain localhost
 *  development still works. */
export function sessionCookie(req: Request, url: URL, token: string, expiresAt: number): string {
  const https = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
    https ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
