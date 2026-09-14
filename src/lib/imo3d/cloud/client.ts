// This module must only be imported by server routes and local worker processes.
export const cloudEnabled=()=>process.env.IMO3D_CLOUD==='1';
export function cloudConfig(){
  if(typeof window!=='undefined')throw new Error('Cloud credentials are server-only.');
  const raw=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!raw||!serviceRoleKey)throw new Error('IMO3D_CLOUD_CONFIG_MISSING');
  const url=new URL(raw);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('IMO3D_CLOUD_URL_INVALID');
  const storageUrl=`https://${url.hostname.replace(/\.supabase\.co$/,'.storage.supabase.co')}`;
  return {url:url.origin,storageUrl,serviceRoleKey,bucket:'imo3d-private'};
}
export class CloudError extends Error{
  constructor(readonly status:number,readonly code:string){super(code==='40001'?'CONFLICT':'Cloud request failed.');this.name='CloudError';}
}
const identifier=(value:string)=>{if(!/^[a-z][a-z0-9_]*$/.test(value))throw new Error('Invalid cloud identifier.');return value.startsWith('imo3d_')?value:`imo3d_${value}`;};
export function cloudObjectPath(key:string){
  if(!key||key.startsWith('/')||key.includes('\\')||key.split('/').some(part=>!part||part==='.'||part==='..')||/[\x00-\x1f]/.test(key))throw new Error('Invalid storage object key.');
  return key.split('/').map(encodeURIComponent).join('/');
}
async function request(endpoint:string,init:RequestInit={},timeout=60000){
  const config=cloudConfig();
  const headers=new Headers(init.headers);headers.set('apikey',config.serviceRoleKey);headers.set('Authorization',`Bearer ${config.serviceRoleKey}`);
  const origin=endpoint.startsWith('/storage/v1/')?config.storageUrl:config.url;
  const response=await fetch(`${origin}${endpoint}`,{...init,headers,cache:'no-store',signal:init.signal??AbortSignal.timeout(timeout)});
  if(!response.ok){const failure=await response.json().catch(()=>null);const candidate=String(failure?.code??response.status);const code=/^[a-zA-Z0-9_]{1,32}$/.test(candidate)?candidate:String(response.status);throw new CloudError(code==='40001'||code==='23505'?409:response.status,code);}
  return response;
}
export async function cloudQuery<T=Record<string,unknown>[]>(table:string,queryString='',method='GET',body?:unknown):Promise<T>{
  if(!['GET','POST','PATCH','DELETE','HEAD'].includes(method))throw new Error('Invalid cloud method.');
  if((method==='PATCH'||method==='DELETE')&&!queryString)throw new Error('Unscoped cloud mutation refused.');
  const response=await request(`/rest/v1/${identifier(table)}${queryString?`?${queryString.replace(/^\?/,'')}`:''}`,{method,headers:{'Content-Type':'application/json',Prefer:'return=representation'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(response.status===204||method==='HEAD')return undefined as T;
  const text=await response.text();return (text?JSON.parse(text):undefined) as T;
}
export async function cloudRpc<T=unknown>(name:string,args:Record<string,unknown>):Promise<T>{
  const response=await request(`/rest/v1/rpc/${identifier(name)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  const text=await response.text();return (text?JSON.parse(text):undefined) as T;
}
export async function cloudUploadObject(key:string,bytes:Uint8Array,mime:string):Promise<void>{
  await request(`/storage/v1/object/${cloudConfig().bucket}/${cloudObjectPath(key)}`,{method:'POST',headers:{'Content-Type':mime,'x-upsert':'false'},body:new Uint8Array(bytes)},120000);
}
export async function cloudDownloadObject(key:string):Promise<Uint8Array>{
  const response=await request(`/storage/v1/object/authenticated/${cloudConfig().bucket}/${cloudObjectPath(key)}`);
  return new Uint8Array(await response.arrayBuffer());
}
export async function cloudSignedDownload(key:string,expiresIn=300):Promise<string>{
  if(!Number.isInteger(expiresIn)||expiresIn<1||expiresIn>3600)throw new Error('Invalid download expiry.');
  const response=await request(`/storage/v1/object/sign/${cloudConfig().bucket}/${cloudObjectPath(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn})});
  const data=await response.json();const candidate=data.signedURL??data.signedUrl;
  if(typeof candidate!=='string')throw new Error('Invalid storage response.');
  const config=cloudConfig(),url=new URL(candidate.startsWith('/object/')?`/storage/v1${candidate}`:candidate,config.storageUrl);
  if(![config.url,config.storageUrl].includes(url.origin)||url.username||url.password)throw new Error('Unexpected storage URL.');return url.href;
}
/** Sign display assets in one storage round trip, instead of one redirect per frame. */
export async function cloudSignedDownloads(keys:string[],expiresIn=300):Promise<Map<string,string>>{
  if(!Number.isInteger(expiresIn)||expiresIn<1||expiresIn>3600)throw new Error('Invalid download expiry.');
  const paths=[...new Set(keys)];paths.forEach(cloudObjectPath);
  if(!paths.length)return new Map();
  const config=cloudConfig();
  const response=await request(`/storage/v1/object/sign/${config.bucket}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths,expiresIn})});
  const data:unknown=await response.json();if(!Array.isArray(data))throw new Error('Invalid storage response.');
  const allowed=new Set(paths),signed=new Map<string,string>();
  for(const row of data){
    if(!row||!allowed.has(row.path)||row.error)continue;
    const candidate=row.signedURL??row.signedUrl;if(typeof candidate!=='string')continue;
    const url=new URL(candidate.startsWith('/object/')?`/storage/v1${candidate}`:candidate,config.storageUrl);
    if(![config.url,config.storageUrl].includes(url.origin)||url.username||url.password)throw new Error('Unexpected storage URL.');
    signed.set(row.path,url.href);
  }
  return signed;
}
export async function cloudSignedUpload(key:string):Promise<{url:string;token:string;path:string}>{
  const response=await request(`/storage/v1/object/upload/sign/${cloudConfig().bucket}/${cloudObjectPath(key)}`,{method:'POST',headers:{'Content-Type':'application/json','x-upsert':'false'},body:'{}'});
  const data=await response.json();const candidate=data.url??data.signedURL;
  if(typeof candidate!=='string')throw new Error('Invalid storage response.');
  const config=cloudConfig(),url=new URL(candidate.startsWith('/object/')?`/storage/v1${candidate}`:candidate,config.storageUrl);
  if(![config.url,config.storageUrl].includes(url.origin)||url.username||url.password)throw new Error('Unexpected storage URL.');
  const token=url.searchParams.get('token');if(!token)throw new Error('Signed upload token missing.');return {url:url.href,token,path:key};
}
