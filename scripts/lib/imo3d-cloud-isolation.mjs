import path from 'node:path';
import ts from 'typescript';
const normalize=value=>value.replaceAll('\\','/');
const isExported=node=>node.modifiers?.some(item=>item.kind===ts.SyntaxKind.ExportKeyword);
const verbs=new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
const runtimeImport=node=>ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly&&!(node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&!node.importClause.name&&node.importClause.namedBindings.elements.every(item=>item.isTypeOnly));
function dependencies(ast){
  const values=ast.statements.filter(node=>runtimeImport(node)||ts.isExportDeclaration(node)&&!node.isTypeOnly&&node.moduleSpecifier).filter(node=>ts.isStringLiteral(node.moduleSpecifier)).map(node=>node.moduleSpecifier.text);
  function scan(node){if(ts.isCallExpression(node)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||['require','process.getBuiltinModule'].includes(node.expression.getText(ast))))values.push(node.arguments[0].text);ts.forEachChild(node,scan);}scan(ast);return [...new Set(values)];
}
function guardedExports(ast){
  const declarations=new Map(),exports=[];
  for(const node of ast.statements){
    if(ts.isFunctionDeclaration(node)&&node.name){declarations.set(node.name.text,node);if(isExported(node)&&verbs.has(node.name.text))exports.push(node.name.text);}
    if(ts.isVariableStatement(node))for(const item of node.declarationList.declarations)if(ts.isIdentifier(item.name)){declarations.set(item.name.text,item.initializer);if(isExported(node)&&verbs.has(item.name.text))exports.push(item.name.text);}
    if(ts.isExportDeclaration(node)&&node.exportClause&&ts.isNamedExports(node.exportClause))for(const item of node.exportClause.elements)if(verbs.has(item.name.text))exports.push(item.propertyName?.text??item.name.text);
  }
  const imports=ast.statements.filter(runtimeImport);
  const binding=(name,source)=>imports.some(node=>node.moduleSpecifier.text===source&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&node.importClause.namedBindings.elements.some(item=>!item.isTypeOnly&&item.name.text===name&&(item.propertyName?.text??item.name.text)===name));
  if(!binding('cloudEnabled','@/lib/imo3d/cloud/client')||!binding('cloudRoute','@/lib/imo3d/cloud/handlers'))return false;
  return exports.length>0&&exports.every(name=>{
    const seen=new Set();let node=declarations.get(name);while(node&&ts.isIdentifier(node)&&!seen.has(node.text)){seen.add(node.text);node=declarations.get(node.text);}
    const first=node?.body&&ts.isBlock(node.body)?node.body.statements[0]:null;
    if(!first||!ts.isIfStatement(first)||first.expression.getText(ast)!=='cloudEnabled()')return false;
    const body=ts.isBlock(first.thenStatement)?first.thenStatement.statements[0]:first.thenStatement;
    return body&&ts.isReturnStatement(body)&&body.expression?.getText(ast)==='cloudRoute(request)';
  });
}
/** Structural source inspection, not a proof of arbitrary JavaScript behavior. */
export function inspectCloudIsolation(sources){
  const root='src/lib/imo3d/cloud/handlers.ts',asts=new Map(Object.entries(sources).filter(([file])=>/\.[cm]?[jt]sx?$/.test(file)).map(([file,text])=>[file,ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true)]));
  const present=asts.has(root),errors=[],reachable=new Set(),apiRoutes=[...asts.keys()].filter(file=>file.startsWith('src/app/api/imo3d/')&&file.endsWith('/route.ts'));
  const resolve=(file,spec)=>{const base=spec.startsWith('@/')?'src/'+spec.slice(2):spec.startsWith('.')?normalize(path.posix.join(path.posix.dirname(file),spec)):null;if(!base)return null;return [base,base+'.ts',base+'.tsx',base+'/index.ts'].find(value=>asts.has(value))??false;};
  function visit(file){if(reachable.has(file))return;reachable.add(file);for(const spec of dependencies(asts.get(file))){const target=resolve(file,spec);if(target===false)errors.push(`${file}: unresolved runtime dependency ${spec}`);else if(target)visit(target);}}
  if(present){visit(root);if(!apiRoutes.length)errors.push('No API route entry points were inspected.');for(const file of apiRoutes)if(!guardedExports(asts.get(file)))errors.push(`${file}: an exported handler lacks a first-statement cloud guard`);}
  const unsafe=[];for(const file of reachable){for(const spec of dependencies(asts.get(file)))if(/^node:(?:sqlite|fs(?:\/promises)?|child_process)$/.test(spec))unsafe.push(`${file}: ${spec}`);}
  if(present&&unsafe.length)errors.push(...unsafe);
  const allReachable=new Set();function allImports(file){if(allReachable.has(file))return;allReachable.add(file);for(const spec of dependencies(asts.get(file))){const target=resolve(file,spec);if(target)allImports(target);}}
  for(const file of apiRoutes)allImports(file);
  // Module imports happen before handlers. Reject direct eager local writes,
  // including writes hidden in top-level initializer expressions or IIFEs.
  const eager=[];
  for(const file of allReachable){const ast=asts.get(file);function scan(node){if(ts.isFunctionDeclaration(node)||ts.isArrowFunction(node)||ts.isFunctionExpression(node)||ts.isMethodDeclaration(node))return;if(ts.isCallExpression(node)||ts.isNewExpression(node)){const name=node.expression.getText(ast);if(/^(?:db|DatabaseSync|mkdirSync|writeFileSync|appendFileSync|unlinkSync|rmSync|spawn|execFile|launchAIPlan|wakeProcessingWorker)$/.test(name)||/\.(?:mkdirSync|writeFileSync|unlinkSync|rmSync|spawn|execFile)$/.test(name))eager.push(`${file}: eager local operation`);}ts.forEachChild(node,scan);}for(const statement of ast.statements)scan(statement);}
  if(present)errors.push(...new Set(eager));
  return{present,isolated:present&&!errors.length,errors:[...new Set(errors)],reachable:[...reachable],routeCount:apiRoutes.length};
}
