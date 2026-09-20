// Local cloud-backed preview; does not deploy or change cloud configuration.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.loadEnvFile(path.join(root,'.env.cloud.local'));
// Keep the local CSRF origin and cookie transport aligned with this listener.
// The saved production environment and deployed origin remain untouched.
const previewEnv={...process.env,IMO3D_PUBLIC_ORIGIN:'http://127.0.0.1:3000'};
const child=spawn(process.execPath,[
  '--dns-result-order=ipv4first','--no-network-family-autoselection',
  path.join(root,'node_modules/next/dist/bin/next'),'dev','--webpack',
  '--hostname','127.0.0.1','--port','3000',
],{cwd:root,stdio:'inherit',windowsHide:true,env:previewEnv});
child.on('error',()=>{console.error('Unable to start the local IMO 3D preview.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
