import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { getLeads, LeadQueryError } from "../src/lib/imo3d/lead-query";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,payload TEXT);
    CREATE TABLE leads(id TEXT PRIMARY KEY,tour_id TEXT,name TEXT,phone TEXT,note TEXT,created_at TEXT);
    INSERT INTO projects VALUES('a','Project A'),('b','Project B');
    INSERT INTO tours VALUES('a-tour','a','{"title":"Tour A"}'),('b-tour','b','{"title":"Tour B"}');`);
  const insert = database.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?)");
  for (let index = 0; index < 6; index++) insert.run(`a-${index}`, "a-tour", `Lead A${index}`, "+966501234567", "", "2026-09-01T00:00:00Z");
  for (let index = 0; index < 1100; index++) insert.run(`b-${index}`, "b-tour", `Lead B${index}`, "+966501234567", "", "2026-09-08T00:00:00Z");
  return database;
}

test("project scope is applied before the page limit even after 1000 newer foreign leads", () => {
  const database = fixture();
  try {
    const page = getLeads(database, { projectId: "a", limit: 1000 });
    assert.equal(page.total, 6); assert.equal(page.leads.length, 6); assert.equal(page.nextCursor, null);
    assert.ok(page.leads.every(lead => lead.projectId === "a" && lead.projectName === "Project A" && lead.tourTitle === "Tour A"));
    assert.equal(getLeads(database, { limit: 1000 }).total, 1106);
  } finally { database.close(); }
});

test("stable pagination visits equal-timestamp leads once, and cursors cannot switch project scope", () => {
  const database = fixture();
  try {
    const first = getLeads(database, { projectId: "a", limit: 2 });
    const second = getLeads(database, { projectId: "a", limit: 2, cursor: first.nextCursor! });
    const third = getLeads(database, { projectId: "a", limit: 2, cursor: second.nextCursor! });
    assert.deepEqual([...first.leads, ...second.leads, ...third.leads].map(lead => lead.id), ["a-5", "a-4", "a-3", "a-2", "a-1", "a-0"]);
    assert.equal(third.nextCursor, null); assert.equal(second.total, 6);
    assert.throws(() => getLeads(database, { projectId: "b", cursor: first.nextCursor! }), LeadQueryError);
    assert.throws(() => getLeads(database, { cursor: first.nextCursor! }), LeadQueryError);
    const empty = getLeads(database, { projectId: "missing" }); assert.equal(empty.total, 0); assert.deepEqual(empty.leads, []);
  } finally { database.close(); }
});

test("invalid limits, project ids and cursor payloads fail validation before SQL lookup", () => {
  const database = fixture();
  try {
    for (const limit of [0, -1, 1001, NaN, 1.5]) assert.throws(() => getLeads(database, { limit }), LeadQueryError);
    assert.throws(() => getLeads(database, { projectId: "' OR 1=1 --" }), LeadQueryError);
    for (const cursor of ["%%%", Buffer.from("null").toString("base64url"), Buffer.from(JSON.stringify({ id: "a-1", createdAt: "invalid", projectId: "a" })).toString("base64url")]) assert.throws(() => getLeads(database, { projectId: "a", cursor }), LeadQueryError);
  } finally { database.close(); }
});
