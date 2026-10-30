import type { WhatsAppCloudCredentials } from "./cloud-api";

export interface PlaygroundMessage {
  id: string;
  direction: "incoming" | "sent";
  text: string;
  sender: string;
  recipient: string;
  timestamp: number;
}

interface PlaygroundSession {
  credentials?: WhatsAppCloudCredentials;
  messages: PlaygroundMessage[];
  seenMessageIds: Set<string>;
  touchedAt: number;
}

const sessions = new Map<string, PlaygroundSession>();
const MAX_MESSAGES = 200;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function prune(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.touchedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function newPlaygroundSession(): string {
  prune();
  const id = crypto.randomUUID();
  sessions.set(id, { messages: [], seenMessageIds: new Set(), touchedAt: Date.now() });
  return id;
}

export function playgroundSession(id: string | undefined): PlaygroundSession | undefined {
  if (!id) return undefined;
  const session = sessions.get(id);
  if (session) session.touchedAt = Date.now();
  return session;
}

export function setPlaygroundCredentials(id: string, credentials: WhatsAppCloudCredentials) {
  const session = playgroundSession(id);
  if (!session) return false;
  session.credentials = credentials;
  return true;
}

export function appendPlaygroundMessage(id: string, message: PlaygroundMessage) {
  const session = playgroundSession(id);
  if (!session || session.seenMessageIds.has(message.id)) return false;
  session.seenMessageIds.add(message.id);
  session.messages.push(message);
  if (session.messages.length > MAX_MESSAGES) {
    const removed = session.messages.splice(0, session.messages.length - MAX_MESSAGES);
    removed.forEach((item) => session.seenMessageIds.delete(item.id));
  }
  return true;
}

export function sessionsForWhatsAppAccount(wabaId: string, phoneNumberId: string) {
  prune();
  return [...sessions.entries()].filter(([, session]) =>
    session.credentials?.phoneNumberId === phoneNumberId
      && (!wabaId || session.credentials.wabaId === wabaId),
  );
}
