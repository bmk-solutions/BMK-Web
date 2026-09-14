import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./store";

import {brandingPatchSchema,defaultBranding,type ProjectBranding} from "./branding-policy";
export {brandingPatchSchema,type ProjectBranding} from "./branding-policy";

function ensureBrandingTables() {
  db().exec(`CREATE TABLE IF NOT EXISTS project_brand_assets(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),mime TEXT NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_branding(
    project_id TEXT PRIMARY KEY REFERENCES projects(id),name TEXT NOT NULL,accent TEXT NOT NULL,
    logo_asset_id TEXT REFERENCES project_brand_assets(id),updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_project_brand_assets_project ON project_brand_assets(project_id);`);
  if(!db().prepare("PRAGMA table_info(project_branding)").all().some(column=>column.name==="logo_style"))db().exec("ALTER TABLE project_branding ADD COLUMN logo_style TEXT NOT NULL DEFAULT 'clean'");
}

export function brandingProjectExists(projectId: string) {
  return !!db().prepare("SELECT 1 FROM projects WHERE id=?").get(projectId);
}

export function brandingProjectReadable(projectId: string, admin: boolean) {
  return admin ? brandingProjectExists(projectId) : !!db().prepare("SELECT 1 FROM tours WHERE project_id=? AND published=1 LIMIT 1").get(projectId);
}

export function brandingForProject(projectId: string): ProjectBranding {
  ensureBrandingTables();
  const row = db().prepare("SELECT name,accent,logo_asset_id,logo_style FROM project_branding WHERE project_id=?").get(projectId);
  if (!row) return { ...defaultBranding };
  return { name: String(row.name), accent: String(row.accent), ...(row.logo_asset_id ? { logo: `/api/imo3d/branding-assets/${row.logo_asset_id}` } : {}),...(row.logo_style==="original"?{logoStyle:"original" as const}:{}) };
}

/** Metadata and logo changes commit together, retaining no abandoned uploads. */
export function saveProjectBranding(projectId: string, input: z.infer<typeof brandingPatchSchema>, logo?: Buffer): ProjectBranding {
  ensureBrandingTables();
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!brandingProjectExists(projectId)) throw new Error("PROJECT_NOT_FOUND");
    const previous = database.prepare("SELECT logo_asset_id,logo_style FROM project_branding WHERE project_id=?").get(projectId);
    const oldId = previous?.logo_asset_id ? String(previous.logo_asset_id) : null;
    let nextId = input.removeLogo ? null : oldId;
    const now = new Date().toISOString();
    if (logo) {
      nextId = randomUUID();
      database.prepare("INSERT INTO project_brand_assets(id,project_id,mime,bytes,created_at) VALUES(?,?,?,?,?)").run(nextId, projectId, "image/webp", logo, now);
    }
    database.prepare(`INSERT INTO project_branding(project_id,name,accent,logo_asset_id,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,accent=excluded.accent,logo_asset_id=excluded.logo_asset_id,updated_at=excluded.updated_at`).run(projectId, input.name, input.accent, nextId, now);
    database.prepare("UPDATE project_branding SET logo_style=? WHERE project_id=?").run(input.logoStyle??previous?.logo_style??"clean",projectId);
    if (oldId && oldId !== nextId) database.prepare("DELETE FROM project_brand_assets WHERE id=? AND project_id=?").run(oldId, projectId);
    database.exec("COMMIT");
    return brandingForProject(projectId);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function readProjectBrandAsset(id: string, admin: boolean, allowedProjectId?: string): { bytes: Buffer; mime: string } | null {
  ensureBrandingTables();
  const row = db().prepare(`SELECT asset.project_id,asset.bytes,asset.mime FROM project_brand_assets asset
    JOIN project_branding branding ON branding.logo_asset_id=asset.id AND branding.project_id=asset.project_id WHERE asset.id=?`).get(id);
  if (!row || (allowedProjectId ? String(row.project_id) !== allowedProjectId : !brandingProjectReadable(String(row.project_id), admin))) return null;
  return { bytes: Buffer.from(row.bytes as Uint8Array), mime: String(row.mime) };
}
