import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { brandingForProject, brandingPatchSchema, brandingProjectReadable, readProjectBrandAsset, saveProjectBranding } from "../src/lib/imo3d/branding";
import { db, newProject, newTour, saveTour } from "../src/lib/imo3d/store";

const workspace = path.resolve("work/imo3d-branding-tests");
mkdirSync(workspace, { recursive: true });
const directory = mkdtempSync(path.join(workspace, "database-"));
process.env.IMO3D_DATA_DIR = directory;
after(() => {
  db().close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path.join(directory, `imo3d.sqlite${suffix}`), { force: true });
  rmdirSync(directory);
});
const assetId = (logo: string) => logo.split("/").at(-1)!;

test("project branding defaults and display-name edits do not rename the underlying project", () => {
  const project = newProject("اسم المشروع الداخلي", "الرياض");
  assert.deepEqual(brandingForProject(project.id), { name: "IMO 3D", accent: "#24b18b" });
  const input = brandingPatchSchema.parse({ name: "  مساكن النخيل  ", accent: "#AB12EF" });
  assert.deepEqual(saveProjectBranding(project.id, input), { name: "مساكن النخيل", accent: "#ab12ef" });
  assert.equal(db().prepare("SELECT name FROM projects WHERE id=?").get(project.id)?.name, "اسم المشروع الداخلي");
});

test("draft logo assets require administration, and publication grants only their own project's access", () => {
  const project = newProject("مشروع خاص", ""), unrelated = newProject("مشروع آخر", "");
  const bytes = Buffer.from("validated raster output fixture");
  const brand = saveProjectBranding(project.id, brandingPatchSchema.parse({ name: "علامتي", accent: "#123456" }), bytes);
  const id = assetId(brand.logo!);
  assert.equal(readProjectBrandAsset(id, false), null);
  assert.deepEqual(readProjectBrandAsset(id, true)?.bytes, bytes);
  assert.equal(brandingProjectReadable(project.id, false), false);
  const otherTour = newTour(unrelated.id, "جولة منشورة لمشروع آخر");
  saveTour({ ...otherTour, published: true }, otherTour.revision);
  assert.equal(readProjectBrandAsset(id, false), null);
  const tour = newTour(project.id, "جولة المشروع");
  const published = saveTour({ ...tour, published: true }, tour.revision);
  assert.equal(readProjectBrandAsset(id, false)?.mime, "image/webp");
  assert.equal(brandingProjectReadable(project.id, false), true);
  saveTour({ ...published, published: false }, published.revision);
  assert.equal(readProjectBrandAsset(id, false), null);
});

test("replacing and removing a logo is atomic and leaves no abandoned logo rows", () => {
  const project = newProject("تبديل العلامة", "");
  const input = brandingPatchSchema.parse({ name: "العلامة", accent: "#123456" });
  const first = saveProjectBranding(project.id, input, Buffer.from("first"));
  const second = saveProjectBranding(project.id, { ...input, name: "الاسم الجديد" }, Buffer.from("second"));
  assert.notEqual(first.logo, second.logo);
  assert.equal(readProjectBrandAsset(assetId(first.logo!), true), null);
  assert.equal(brandingForProject(project.id).name, "الاسم الجديد");
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM project_brand_assets WHERE project_id=?").get(project.id)?.count, 1);
  const removed = saveProjectBranding(project.id, { ...input, removeLogo: true });
  assert.equal(removed.logo, undefined);
  assert.equal(readProjectBrandAsset(assetId(second.logo!), true), null);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM project_brand_assets WHERE project_id=?").get(project.id)?.count, 0);
});

test("metadata-only edits preserve the logo and invalid project updates roll back completely", () => {
  const project = newProject("حفظ العلامة", "");
  const input = brandingPatchSchema.parse({ name: "علامة", accent: "#123456" });
  const first = saveProjectBranding(project.id, input, Buffer.from("logo"));
  const edited = saveProjectBranding(project.id, { ...input, name: "الاسم المحدث" });
  assert.equal(edited.logo, first.logo);
  const before = db().prepare("SELECT COUNT(*) AS count FROM project_brand_assets").get()?.count;
  assert.throws(() => saveProjectBranding("missing-project", input, Buffer.from("unused")), /PROJECT_NOT_FOUND/);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM project_brand_assets").get()?.count, before);
  assert.equal(brandingProjectReadable("missing-project", true), false);
});

test("branding validation enforces nonempty bounded names and plain hexadecimal colors", () => {
  for (const name of ["", "    ", "x".repeat(81)]) assert.equal(brandingPatchSchema.safeParse({ name, accent: "#123456" }).success, false);
  for (const accent of ["red", "#fff", "url(https://outside.example)", "#123456;background:red", "#gggggg"]) assert.equal(brandingPatchSchema.safeParse({ name: "علامة", accent }).success, false);
  assert.equal(brandingPatchSchema.parse({ name: "علامة", accent: "#A1B2C3" }).accent, "#a1b2c3");
  for(const logoStyle of ["", "white", "invalid"])assert.equal(brandingPatchSchema.safeParse({name:"علامة",accent:"#123456",logoStyle}).success,false);
});

test("display style persists across metadata edits without changing stored logo bytes or draft access",()=>{
  const project=newProject("نمط عرض الشعار",""),other=newProject("علامة مستقلة","");
  const input=brandingPatchSchema.parse({name:"علامة",accent:"#123456"}),bytes=Buffer.from("stored raster remains unchanged");
  const initial=saveProjectBranding(project.id,input,bytes),id=assetId(initial.logo!);
  const original=saveProjectBranding(project.id,{...input,logoStyle:"original"});
  assert.equal(original.logoStyle,"original");
  assert.equal(original.logo,initial.logo);
  saveProjectBranding(project.id,{...input,name:"تحديث الاسم فقط"});
  assert.equal(brandingForProject(project.id).logoStyle,"original");
  const clean=saveProjectBranding(project.id,{...input,logoStyle:"clean"});
  assert.equal(clean.logoStyle,undefined);
  assert.equal(clean.logo,initial.logo);
  assert.deepEqual(readProjectBrandAsset(id,true)?.bytes,bytes);
  assert.equal(readProjectBrandAsset(id,false),null);
  assert.equal(readProjectBrandAsset(id,false,other.id),null);
  assert.deepEqual(readProjectBrandAsset(id,false,project.id)?.bytes,bytes);
});

test("replacement keeps the chosen presentation while an explicit switch resets it",()=>{
  const project=newProject("استبدال مع حفظ النمط","");
  const input=brandingPatchSchema.parse({name:"علامة",accent:"#123456"});
  const first=saveProjectBranding(project.id,{...input,logoStyle:"original"},Buffer.from("first"));
  const second=saveProjectBranding(project.id,input,Buffer.from("second"));
  assert.equal(second.logoStyle,"original");
  assert.notEqual(second.logo,first.logo);
  assert.equal(readProjectBrandAsset(assetId(first.logo!),true),null);
  const third=saveProjectBranding(project.id,{...input,logoStyle:"clean"},Buffer.from("third"));
  assert.equal(third.logoStyle,undefined);
  assert.deepEqual(readProjectBrandAsset(assetId(third.logo!),true)?.bytes,Buffer.from("third"));
});
