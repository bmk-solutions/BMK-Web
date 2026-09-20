import {access,readFile} from 'node:fs/promises';
import path from 'node:path';

// Hosted machines use their own executable, not a developer's Windows paths.
export async function workerRuntimePresent(root,env=process.env){
  try{
    let python=env.IMO3D_PYTHON;
    if(!python){const runtime=JSON.parse(await readFile(path.join(root,'work','reconstruction-runtime.json'),'utf8'));python=runtime.python;}
    if(!python)return false;
    await access(python);
    return true;
  }catch{return false;}
}
