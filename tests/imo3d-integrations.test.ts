import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { createIntegrationKey, integrationForRequest, integrationKeysForProject, revokeIntegrationKey } from "../src/lib/imo3d/integrations";
import { brandingPatchSchema, readProjectBrandAsset, saveProjectBranding } from "../src/lib/imo3d/branding";
import { login } from "../src/lib/imo3d/auth";
import { db, newProject } from "../src/lib/imo3d/store";

const workspace = path.resolve("work/imo3d-integration-tests");
mkdirSync(workspace, { recursive: true });
const directory = mkdtempSync(path.join(workspace, "database-"));
process.env.IMO3D_DATA_DIR = directory;
after(() => {
  db().close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path.join(directory, `imo3d.sqlite${suffix}`), { force: true });
  rmdirSync(directory);
});
const request = (secret: string) => new Request("http://127.0.0.1:3001/api/imo3d/tours", { headers: { Authorization: `Bearer ${secret}` } });

test("API secrets have 256 random bits and only their SHA256 hashes are persisted", () => {
  const project = newProject("المشروع الأول", "");
  const { key, secret } = createIntegrationKey(project.id, "نظام المبيعات", ["read", "write"]);
  assert.match(secret, /^imo3d_[A-Za-z0-9_-]{43}$/);
  const stored = db().prepare("SELECT * FROM integration_keys WHERE id=?").get(key.id)!;
  assert.equal(stored.secret_hash, createHash("sha256").update(secret).digest("hex"));
  assert.equal(Object.values(stored).includes(secret), false);
  const listed = integrationKeysForProject(project.id);
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal("secret_hash" in listed[0], false);
  assert.equal("secret" in listed[0], false);
  assert.notEqual(createIntegrationKey(project.id, "مفتاح آخر", ["read"]).secret, secret);
});

test("authentication returns exactly the key's project and selected scopes and tracks use", () => {
  const project = newProject("مشروع النطاق", "");
  const { key, secret } = createIntegrationKey(project.id, "قراءة فقط", ["read"]);
  assert.deepEqual(integrationForRequest(request(secret)), { id: key.id, projectId: project.id, scopes: ["read"] });
  assert.ok(integrationKeysForProject(project.id)[0].lastUsedAt);
  for (const value of ["", "imo3d_short", "imo3d_" + "a".repeat(43), secret + "extra", secret.toUpperCase()]) assert.equal(integrationForRequest(request(value)), null);
  assert.equal(integrationForRequest(new Request("http://127.0.0.1:3001")), null);
});

test("revocation is immediate and cannot accidentally target another project's key", () => {
  const a = newProject("مشروع أ", ""), b = newProject("مشروع ب", "");
  const { key, secret } = createIntegrationKey(a.id, "اتصال", ["read", "leads"]);
  assert.equal(revokeIntegrationKey(b.id, key.id), false);
  assert.ok(integrationForRequest(request(secret)));
  assert.deepEqual(integrationKeysForProject(b.id), []);
  assert.equal(revokeIntegrationKey(a.id, key.id), true);
  assert.equal(integrationForRequest(request(secret)), null);
  assert.ok(integrationKeysForProject(a.id)[0].revokedAt);
});

test("a scoped logo read only grants access to assets from that exact project", () => {
  const a = newProject("شعار أ", ""), b = newProject("شعار ب", "");
  const branding = saveProjectBranding(a.id, brandingPatchSchema.parse({ name: "العلامة", accent: "#123456" }), Buffer.from("validated raster fixture"));
  const id = branding.logo!.split("/").at(-1)!;
  assert.ok(readProjectBrandAsset(id, false, a.id));
  assert.equal(readProjectBrandAsset(id, false, b.id), null);
  assert.equal(readProjectBrandAsset(id, false), null);
});

test("HTTPS public origins issue Secure session cookies behind internal HTTP proxies", () => {
  const previousSecret = process.env.IMO3D_ADMIN_SECRET, previousOrigin = process.env.IMO3D_PUBLIC_ORIGIN;
  const secret = "isolated-unit-test-secret-01234567890123456789";
  try {
    process.env.IMO3D_ADMIN_SECRET = secret;
    process.env.IMO3D_PUBLIC_ORIGIN = "https://viewer.example.test";
    const cookie = login(new Request("http://internal-node:3000/api/imo3d/session"), secret);
    assert.ok(cookie?.includes("; Secure"));
    assert.ok(cookie?.includes("; HttpOnly"));
    assert.ok(cookie?.includes("; SameSite=Strict"));
  } finally {
    if (previousSecret === undefined) delete process.env.IMO3D_ADMIN_SECRET; else process.env.IMO3D_ADMIN_SECRET = previousSecret;
    if (previousOrigin === undefined) delete process.env.IMO3D_PUBLIC_ORIGIN; else process.env.IMO3D_PUBLIC_ORIGIN = previousOrigin;
  }
});
