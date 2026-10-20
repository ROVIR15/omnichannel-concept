// HTTP endpoints for signing in and managing the team. authorize() has
// already run, so role and organisation checks are done by the time these
// handlers see a request; what's left here is input validation.

import { getOrg } from "../store";
import {
  clearedSessionCookie, createSession, deleteSession, deleteSessionsOf, sessionCookie,
} from "./sessions";
import {
  MIN_PASSWORD_LENGTH, PRESENCES, countUsers, createUser, deleteUser, getUser, listUsers,
  markLoggedIn, updateUser, validEmail, verifyLogin, type Presence, type Role, type User,
} from "./users";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status, headers: { "content-type": "application/json", ...headers },
  });

async function body(req: Request): Promise<Record<string, any> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : null;
  } catch { return null; }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function passwordProblem(password: string): string | null {
  return password.length < MIN_PASSWORD_LENGTH ? `password must be at least ${MIN_PASSWORD_LENGTH} characters` : null;
}

async function signIn(req: Request, url: URL, user: User) {
  markLoggedIn(user.id);
  const { token, expiresAt } = createSession(user.id);
  return json(getUser(user.id), 200, { "set-cookie": sessionCookie(req, url, token, expiresAt) });
}

/** Team members an admin can create or assign. Operators are made at setup. */
const TEAM_ROLES: Role[] = ["admin", "agent"];

export async function handleAuthRoutes(
  req: Request, url: URL, user: User | null, token: string | null,
): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  // --- Signing in -------------------------------------------------------
  if (path === "/api/auth/state" && method === "GET") {
    return json({ setupNeeded: countUsers() === 0 });
  }

  // First run only: the very first account becomes the platform operator.
  if (path === "/api/auth/setup" && method === "POST") {
    if (countUsers() > 0) return json({ error: "setup is already done — sign in instead" }, 409);
    const b = await body(req);
    const name = str(b?.name).trim(), email = str(b?.email).trim(), password = str(b?.password);
    if (!name || !validEmail(email)) return json({ error: "name and a valid email are required" }, 400);
    const bad = passwordProblem(password);
    if (bad) return json({ error: bad }, 400);
    const created = await createUser({ orgId: null, email, name, password, role: "operator" });
    return signIn(req, url, created);
  }

  if (path === "/api/auth/login" && method === "POST") {
    const b = await body(req);
    const found = await verifyLogin(str(b?.email), str(b?.password));
    if (!found) return json({ error: "wrong email or password" }, 401);
    return signIn(req, url, found);
  }

  if (path === "/api/auth/logout" && method === "POST") {
    if (user) await updateUser(user.id, { presence: "offline" });
    deleteSession(token);
    return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
  }

  // --- Own account ------------------------------------------------------
  if (path === "/api/auth/me" && user) {
    if (method === "GET") return json({ ...user, orgName: user.orgId ? getOrg(user.orgId)?.name ?? null : null });

    if (method === "PATCH") {
      const b = await body(req);
      if (!b) return json({ error: "invalid JSON body" }, 400);
      const patch: { name?: string; presence?: Presence; password?: string } = {};

      if (b.name !== undefined) {
        if (!str(b.name).trim()) return json({ error: "name can't be empty" }, 400);
        patch.name = str(b.name);
      }
      if (b.presence !== undefined) {
        if (!PRESENCES.includes(b.presence)) return json({ error: `presence must be one of ${PRESENCES.join(", ")}` }, 400);
        patch.presence = b.presence;
      }
      if (b.newPassword !== undefined) {
        if (!(await verifyLogin(user.email, str(b.currentPassword)))) {
          return json({ error: "current password is wrong" }, 400);
        }
        const bad = passwordProblem(str(b.newPassword));
        if (bad) return json({ error: bad }, 400);
        patch.password = str(b.newPassword);
      }

      const updated = await updateUser(user.id, patch);
      if (patch.password) deleteSessionsOf(user.id, token); // sign out other devices
      return json(updated);
    }
  }

  // --- Team (admins manage their org; operators any org) -----------------
  if (path === "/api/agents" && method === "GET") {
    const orgId = url.searchParams.get("org");
    if (!orgId || !getOrg(orgId)) return json({ error: "org query parameter is required" }, 400);
    return json(listUsers(orgId));
  }

  if (path === "/api/agents" && method === "POST") {
    const b = await body(req);
    const orgId = str(b?.orgId), name = str(b?.name).trim(), email = str(b?.email).trim();
    const password = str(b?.password), role = str(b?.role || "agent") as Role;
    if (!getOrg(orgId)) return json({ error: "orgId must be an existing organisation" }, 400);
    if (!name || !validEmail(email)) return json({ error: "name and a valid email are required" }, 400);
    if (!TEAM_ROLES.includes(role)) return json({ error: "role must be admin or agent" }, 400);
    const bad = passwordProblem(password);
    if (bad) return json({ error: bad }, 400);
    try {
      return json(await createUser({ orgId, email, name, password, role }), 201);
    } catch (err: any) {
      if (String(err?.message).includes("UNIQUE")) return json({ error: "someone already uses that email" }, 409);
      throw err;
    }
  }

  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && user) {
    const target = getUser(agentMatch[1]!);
    if (!target) return json({ error: "user not found" }, 404);
    if (target.role === "operator") return json({ error: "operators can't be changed here" }, 403);
    const self = target.id === user.id;

    if (method === "PATCH") {
      const b = await body(req);
      if (!b) return json({ error: "invalid JSON body" }, 400);
      const patch: { name?: string; role?: Role; password?: string } = {};
      if (b.name !== undefined) {
        if (!str(b.name).trim()) return json({ error: "name can't be empty" }, 400);
        patch.name = str(b.name);
      }
      if (b.role !== undefined && b.role !== target.role) {
        if (self) return json({ error: "you can't change your own role" }, 400);
        if (!TEAM_ROLES.includes(b.role)) return json({ error: "role must be admin or agent" }, 400);
        patch.role = b.role;
      }
      if (b.password !== undefined) {
        const bad = passwordProblem(str(b.password));
        if (bad) return json({ error: bad }, 400);
        patch.password = str(b.password);
      }
      const updated = await updateUser(target.id, patch);
      // A new password or role takes effect now, not at their next sign-in.
      if (patch.password || patch.role) deleteSessionsOf(target.id, self ? token : null);
      return json(updated);
    }

    if (method === "DELETE") {
      if (self) return json({ error: "you can't remove yourself" }, 400);
      deleteUser(target.id);
      return json({ ok: true });
    }
  }

  return null;
}
