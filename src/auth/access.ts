// Who may call what. Every request passes authorize() before routing:
//
//   1. Public paths (webhooks, health, the login page) skip it entirely.
//   2. Everything else needs a signed-in user.
//   3. The first matching RULE sets the lowest role allowed. No rule match
//      means operator only, so a new route is locked down until listed here.
//   4. Admins and agents may only touch their own organisation. The org is
//      read from the request (query, path or body, or the record it points
//      at); a request that names no org is refused unless its rule says
//      `orgFree`.

import { getAccount, getConversation } from "../store";
import { sessionToken, userForToken } from "./sessions";
import { getUser, type Role, type User } from "./users";

const RANK: Record<Role, number> = { agent: 0, admin: 1, operator: 2 };

interface Rule {
  method: string | string[];
  path: RegExp;
  min: Role;
  /** The route is safe without naming an org (it filters, or uses a state token). */
  orgFree?: boolean;
}

const RULES: Rule[] = [
  // Pages. Settings and Permissions are provider-level: operator only.
  { method: "GET", path: /^\/(inbox|voice)$/, min: "agent", orgFree: true },
  // Browser calling token for the signed-in user.
  { method: "GET", path: /^\/api\/voice\/token$/, min: "agent", orgFree: true },
  // Calls have no org yet (one platform number); the routes limit agents to their own calls.
  { method: "GET", path: /^\/api\/voice\/calls(\/[^/]+\/transcript)?$/, min: "agent", orgFree: true },
  { method: "GET", path: /^\/(channels|agents)$/, min: "admin", orgFree: true },
  // An organisation's phone numbers: org in the query, or orgId in the body.
  { method: "GET", path: /^\/api\/voice\/numbers$/, min: "admin" },
  { method: "POST", path: /^\/api\/voice\/numbers(\/check)?$/, min: "admin" },
  { method: "DELETE", path: /^\/api\/voice\/numbers\/[^/]+$/, min: "admin" },

  // Signed-in user's own account.
  { method: ["GET", "PATCH"], path: /^\/api\/auth\/me$/, min: "agent", orgFree: true },
  { method: "POST", path: /^\/api\/auth\/logout$/, min: "agent", orgFree: true },

  // Organisations: everyone may list (filtered to their own); changes are operator only.
  { method: "GET", path: /^\/api\/orgs$/, min: "agent", orgFree: true },

  // Inbox.
  { method: "GET", path: /^\/api\/channels$/, min: "agent" },
  { method: ["GET", "POST"], path: /^\/api\/conversations$/, min: "agent" },
  { method: "POST", path: /^\/api\/conversations\/[^/]+\/reply$/, min: "agent" },
  { method: "GET", path: /^\/api\/integrations\/(gmail|outlook)\/(status|messages)$/, min: "agent" },
  { method: "GET", path: /^\/api\/integrations\/(gmail|outlook)\/attachments\/[^/]+\/[^/]+$/, min: "agent" },
  { method: "POST", path: /^\/api\/integrations\/(gmail|email)\/send$/, min: "agent" },

  // Channel setup.
  { method: "POST", path: /^\/api\/channels$/, min: "admin" },
  { method: "DELETE", path: /^\/api\/channels\/[^/]+$/, min: "admin" },
  { method: "GET", path: /^\/api\/integrations\/(gmail|outlook|facebook)\/connect$/, min: "admin" },
  { method: "POST", path: /^\/api\/integrations\/(gmail|outlook)\/disconnect$/, min: "admin" },
  // The provider redirects here; the single-use state minted by /connect carries the org.
  { method: "GET", path: /^\/api\/integrations\/(gmail|outlook|facebook)\/callback$/, min: "admin", orgFree: true },
  { method: "GET", path: /^\/api\/integrations\/facebook\/status$/, min: "admin", orgFree: true },
  { method: ["GET", "POST"], path: /^\/api\/integrations\/facebook\/pages$/, min: "admin" },

  // Team management.
  { method: ["GET", "POST"], path: /^\/api\/agents$/, min: "admin" },
  { method: ["PATCH", "DELETE"], path: /^\/api\/agents\/[^/]+$/, min: "admin" },
];

/** Reachable without signing in. */
export function isPublic(path: string, method: string): boolean {
  return path === "/health"
    || path === "/login"
    || path === "/web/shell.css"
    || path === "/web/shell.js"
    || path.startsWith("/webhooks/")
    || (method === "GET" && path === "/api/auth/state")
    || (method === "POST" && (path === "/api/auth/login" || path === "/api/auth/setup"));
}

function ruleFor(method: string, path: string): Rule | undefined {
  return RULES.find((r) =>
    (Array.isArray(r.method) ? r.method.includes(method) : r.method === method) && r.path.test(path));
}

/** Every organisation the request refers to. A reference to a record that
 *  doesn't exist yields "", which matches no one. */
async function orgsReferenced(req: Request, url: URL): Promise<string[]> {
  const refs: string[] = [];
  const path = url.pathname;

  const q = url.searchParams.get("org");
  if (q !== null) refs.push(q);

  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/orgs\/([^/]+)$/))) refs.push(m[1]!);
  if ((m = path.match(/^\/api\/channels\/([^/]+)$/))) refs.push(getAccount(m[1]!)?.orgId ?? "");
  if ((m = path.match(/^\/api\/conversations\/([^/]+)\//))) refs.push(getConversation(m[1]!)?.org_id ?? "");
  if ((m = path.match(/^\/api\/agents\/([^/]+)$/))) refs.push(getUser(m[1]!)?.orgId ?? "");

  if (req.method !== "GET" && req.method !== "HEAD") {
    const b: any = await req.clone().json().catch(() => null);
    if (b && typeof b === "object") {
      if (b.orgId !== undefined) refs.push(String(b.orgId));
      if (b.accountId !== undefined) refs.push(getAccount(String(b.accountId))?.orgId ?? "");
      // POST /api/channels with an id edits an existing account.
      if (path === "/api/channels" && b.id) refs.push(getAccount(String(b.id))?.orgId ?? "");
    }
  }
  return refs;
}

export type AuthResult =
  | { ok: true; user: User | null; token: string | null }
  | { ok: false; response: Response };

const deny = (status: number, error: string) => ({
  ok: false as const,
  response: new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } }),
});

const isPage = (path: string) => !path.startsWith("/api/");

// Relative Location: behind a tunnel the request URL says localhost.
const redirectTo = (to: string) => ({
  ok: false as const,
  response: new Response(null, { status: 302, headers: { location: to } }),
});

export async function authorize(req: Request, url: URL): Promise<AuthResult> {
  const path = url.pathname;
  const method = req.method;
  if (isPublic(path, method)) return { ok: true, user: null, token: null };

  const token = sessionToken(req);
  const user = userForToken(token);
  if (!user) {
    if (isPage(path)) {
      return redirectTo(`/login?next=${encodeURIComponent(path + url.search)}`);
    }
    return deny(401, "sign in required");
  }
  if (user.role === "operator") return { ok: true, user, token };

  const rule = ruleFor(method, path);
  if (!rule || RANK[user.role] < RANK[rule.min]) {
    // A page they can't open sends them to the one everyone can.
    if (isPage(path)) return redirectTo("/inbox");
    return deny(403, "you don't have access to this");
  }

  const refs = await orgsReferenced(req, url);
  if (refs.length === 0 && !rule.orgFree) return deny(403, "this request must name your organisation");
  if (refs.some((o) => o !== user.orgId)) return deny(403, "you don't have access to that organisation");

  return { ok: true, user, token };
}
