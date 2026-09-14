import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "./store";

export type IntegrationScope = "read" | "write" | "leads";
export type IntegrationAccess = { id: string; projectId: string; scopes: IntegrationScope[] };
export type IntegrationKey = {
  id: string; name: string; prefix: string; scopes: IntegrationScope[];
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
};

function ensureIntegrationTables() {
  db().exec(`CREATE TABLE IF NOT EXISTS integration_keys(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,
    prefix TEXT NOT NULL,secret_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT,revoked_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_integration_keys_project ON integration_keys(project_id,created_at);`);
}
const keyRecord = (row: Record<string, unknown>): IntegrationKey => ({
  id: String(row.id), name: String(row.name), prefix: String(row.prefix), scopes: JSON.parse(String(row.scopes)),
  createdAt: String(row.created_at), lastUsedAt: row.last_used_at ? String(row.last_used_at) : null, revokedAt: row.revoked_at ? String(row.revoked_at) : null,
});
export function integrationProjectExists(projectId: string) {
  return !!db().prepare("SELECT 1 FROM projects WHERE id=?").get(projectId);
}
export function integrationKeysForProject(projectId: string): IntegrationKey[] {
  ensureIntegrationTables();
  return db().prepare("SELECT id,name,prefix,scopes,created_at,last_used_at,revoked_at FROM integration_keys WHERE project_id=? ORDER BY created_at DESC,rowid DESC").all(projectId).map(keyRecord);
}
export function createIntegrationKey(projectId: string, name: string, scopes: IntegrationScope[]): { key: IntegrationKey; secret: string } {
  ensureIntegrationTables();
  const secret = `imo3d_${randomBytes(32).toString("base64url")}`;
  const key: IntegrationKey = { id: randomUUID(), name, prefix: secret.slice(0, 13), scopes: [...new Set(scopes)], createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null };
  db().prepare("INSERT INTO integration_keys(id,project_id,name,prefix,secret_hash,scopes,created_at) VALUES(?,?,?,?,?,?,?)").run(key.id, projectId, name, key.prefix, createHash("sha256").update(secret).digest("hex"), JSON.stringify(key.scopes), key.createdAt);
  return { key, secret };
}
export function revokeIntegrationKey(projectId: string, id: string) {
  ensureIntegrationTables();
  return db().prepare("UPDATE integration_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND project_id=?").run(new Date().toISOString(), id, projectId).changes > 0;
}
/** Invalid, unknown and revoked credentials grant no authority. Raw keys are never stored. */
export function integrationForRequest(request: Request): IntegrationAccess | null {
  const authorization = request.headers.get("authorization");
  const secret = /^Bearer (imo3d_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? "")?.[1];
  if (!secret) return null;
  ensureIntegrationTables();
  const row = db().prepare("SELECT id,project_id,scopes,last_used_at FROM integration_keys WHERE secret_hash=? AND revoked_at IS NULL").get(createHash("sha256").update(secret).digest("hex"));
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(String(row.last_used_at)) > 60_000) db().prepare("UPDATE integration_keys SET last_used_at=? WHERE id=? AND revoked_at IS NULL").run(new Date(now).toISOString(), String(row.id));
  return { id: String(row.id), projectId: String(row.project_id), scopes: JSON.parse(String(row.scopes)) };
}
