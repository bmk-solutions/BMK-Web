import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';

const outputRoot = path.resolve('work/imo3d-gemini-tests');
const files = ['src/lib/imo3d/gemini-transport.ts', 'tests/imo3d-gemini-transport.test.ts', 'src/lib/imo3d/gemini-plan-provider.ts', 'tests/imo3d-gemini-plan-provider.test.ts'];
for (const file of files) {
  const output = path.join(outputRoot, file.replace(/\.ts$/, '.js'));
  mkdirSync(path.dirname(output), {recursive: true});
  writeFileSync(output, ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  }}).outputText);
}
// Every test injects fetch. This suite uses synthetic images and never calls a provider.
const result = spawnSync(process.execPath, ['--test', path.join(outputRoot, 'tests/imo3d-gemini-transport.test.js'), path.join(outputRoot, 'tests/imo3d-gemini-plan-provider.test.js')], {stdio: 'inherit'});
process.exit(result.status ?? 1);
