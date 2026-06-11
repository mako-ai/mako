/**
 * Encrypted on-disk store for local database connections.
 *
 * Connections registered with the Mako Local Agent never leave this machine:
 * credentials are AES-256-GCM encrypted with a key generated on first run and
 * stored under the agent home directory (default: ~/.mako/agent).
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface StoredConnection {
  id: string;
  name: string;
  type: string;
  /** AES-256-GCM payload: iv:authTag:ciphertext (hex) */
  encryptedConnection: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

export interface LocalConnection {
  id: string;
  name: string;
  type: string;
  connection: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

export const LOCAL_CONNECTION_ID_PREFIX = "local_";

export function agentHomeDir(): string {
  return (
    process.env.MAKO_AGENT_HOME || path.join(os.homedir(), ".mako", "agent")
  );
}

function keyPath(): string {
  return path.join(agentHomeDir(), "agent.key");
}

function connectionsPath(): string {
  return path.join(agentHomeDir(), "connections.json");
}

function ensureHomeDir(): void {
  fs.mkdirSync(agentHomeDir(), { recursive: true, mode: 0o700 });
}

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;
  ensureHomeDir();
  if (fs.existsSync(keyPath())) {
    _key = Buffer.from(fs.readFileSync(keyPath(), "utf8").trim(), "hex");
  } else {
    _key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath(), _key.toString("hex"), { mode: 0o600 });
  }
  return _key;
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

function readAll(): StoredConnection[] {
  ensureHomeDir();
  if (!fs.existsSync(connectionsPath())) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(connectionsPath(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(connections: StoredConnection[]): void {
  ensureHomeDir();
  fs.writeFileSync(connectionsPath(), JSON.stringify(connections, null, 2), {
    mode: 0o600,
  });
}

function toLocal(stored: StoredConnection): LocalConnection {
  return {
    id: stored.id,
    name: stored.name,
    type: stored.type,
    connection: JSON.parse(decrypt(stored.encryptedConnection)),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    lastConnectedAt: stored.lastConnectedAt,
  };
}

export function listConnections(): LocalConnection[] {
  return readAll().map(toLocal);
}

export function getConnection(id: string): LocalConnection | null {
  const stored = readAll().find(c => c.id === id);
  return stored ? toLocal(stored) : null;
}

export function createConnection(input: {
  name: string;
  type: string;
  connection: Record<string, unknown>;
}): LocalConnection {
  const now = new Date().toISOString();
  const stored: StoredConnection = {
    id: `${LOCAL_CONNECTION_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`,
    name: input.name,
    type: input.type,
    encryptedConnection: encrypt(JSON.stringify(input.connection)),
    createdAt: now,
    updatedAt: now,
  };
  const all = readAll();
  all.push(stored);
  writeAll(all);
  return toLocal(stored);
}

export function updateConnection(
  id: string,
  input: {
    name?: string;
    connection?: Record<string, unknown>;
  },
): LocalConnection | null {
  const all = readAll();
  const idx = all.findIndex(c => c.id === id);
  if (idx === -1) return null;
  if (input.name) all[idx].name = input.name;
  if (input.connection) {
    all[idx].encryptedConnection = encrypt(JSON.stringify(input.connection));
  }
  all[idx].updatedAt = new Date().toISOString();
  writeAll(all);
  return toLocal(all[idx]);
}

export function touchLastConnected(id: string): void {
  const all = readAll();
  const idx = all.findIndex(c => c.id === id);
  if (idx === -1) return;
  all[idx].lastConnectedAt = new Date().toISOString();
  writeAll(all);
}

export function deleteConnection(id: string): boolean {
  const all = readAll();
  const next = all.filter(c => c.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}
