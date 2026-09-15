import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {cloudQuery} from './client';
import {cloudIsAdmin,cloudSameOrigin} from './auth';
import {listProjects,withinRateLimit} from './repository';
import {CloudHTTPError,eq,json,readBytes,readJSON} from './http';
export const chatgptScope='imo3d:analyze';
export const chatgptOrigin=()=>new URL(process.env.IMO3D_PUBLIC_ORIGIN||'https://bmk-imo3d.vercel.app').origin;
export const chatgptResource=()=>chatgptOrigin()+'/api/imo3d-chatgpt/mcp';
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function signedValue(value:unknown){const secret=process.env.IMO3D_SESSION_SECRET;if(!secret||secret.length<32)throw Error('Signing secret unavailable');const data=Buffer.from(JSON.stringify(value)).toString('base64url');return data+'.'+createHmac('sha256',secret).update('chatgpt:'+data).digest('base64url');}
export function verifiedValue(value:string):unknown{
 const [data,signature,...extra]=value.split('.');if(!data||!signature||extra.length||value.length>6000)throw new CloudHTTPError('Invalid signed value');
 let parsed:unknown;try{parsed=JSON.parse(Buffer.from(data,'base64url').toString());}catch{throw new CloudHTTPError('Invalid signed value');}
 const expected=Buffer.from(signedValue(parsed)),actual=Buffer.from(value);
 if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new CloudHTTPError('Invalid signed value');return parsed;
}
const redirectSchema=z.string().url().max(500).refine(value=>{const url=new URL(value);return url.origin==='https://chatgpt.com'&&!url.search&&!url.hash&&!url.username&&!url.password&&(/^\/connector\/oauth\/[\w-]+$/.test(url.pathname)||url.pathname==='/connector_platform_oauth_redirect');},'Use the exact ChatGPT MCP OAuth callback URL.');
const clientSchema=z.object({kind:z.literal('client'),redirect_uris:z.array(redirectSchema).min(1).max(5),expires:z.number()});
function client(id:string){const data=clientSchema.parse(verifiedValue(id));if(data.expires<Date.now())throw new CloudHTTPError('Client registration expired');return data;}
const authorizationSchema=z.object({client_id:z.string().max(6000),redirect_uri:redirectSchema,response_type:z.literal('code'),code_challenge:z.string().regex(/^[\w-]{43}$/),code_challenge_method:z.literal('S256'),state:z.string().min(1).max(1500),scope:z.literal(chatgptScope),resource:z.string().url()});
export function authorization(input:unknown){const args=authorizationSchema.parse(input),registered=client(args.client_id);if(!registered.redirect_uris.includes(args.redirect_uri)||args.resource!==chatgptResource())throw new CloudHTTPError('Invalid redirect or resource');return args;}
export type ChatGPTConnection={id:string;project_id:string;client_id:string;expires_at:string;refresh_expires_at:string};
export async function chatgptConnection(request:Request){
 const match=/^Bearer (imoc_[\w-]{43})$/i.exec(request.headers.get('authorization')??'');if(!match)return null;
 return (await cloudQuery<ChatGPTConnection[]>('chatgpt_connections',`access_hash=eq.${digest(match[1])}&revoked_at=is.null&expires_at=gt.${eq(new Date().toISOString())}&select=id,project_id,client_id,expires_at,refresh_expires_at&limit=1`))[0]??null;
}
export function authMetadata(){const root=chatgptOrigin();return{issuer:root,authorization_endpoint:root+'/imo3d/connect-chatgpt',token_endpoint:root+'/api/imo3d-chatgpt/token',registration_endpoint:root+'/api/imo3d-chatgpt/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:[chatgptScope],authorization_response_iss_parameter_supported:true};}
export function resourceMetadata(){return{resource:chatgptResource(),authorization_servers:[chatgptOrigin()],scopes_supported:[chatgptScope],bearer_methods_supported:['header']};}
export async function chatgptOAuth(request:Request,action:string){
 if(action==='register'&&request.method==='POST'){
  if(!await withinRateLimit('chatgpt-register',100,3600000))throw new CloudHTTPError('Try again later',429);
  const body=z.object({redirect_uris:z.array(redirectSchema).min(1).max(5),token_endpoint_auth_method:z.literal('none').optional(),grant_types:z.array(z.enum(['authorization_code','refresh_token'])).optional(),response_types:z.array(z.literal('code')).optional()}).passthrough().parse(await readJSON(request,8000));
  const id=signedValue({kind:'client',redirect_uris:body.redirect_uris,expires:Date.now()+30*86400000});
  return json({client_id:id,redirect_uris:body.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},201);
 }
 if(action==='authorize'){
  if(!await cloudIsAdmin(request))throw new CloudHTTPError('دخول إدارة IMO 3D مطلوب.',401);
  if(request.method==='GET'){const args=authorization(Object.fromEntries(new URL(request.url).searchParams));void args;return json({projects:await listProjects()});}
  if(request.method!=='POST'||!cloudSameOrigin(request))throw new CloudHTTPError('Invalid origin',403);
  const body=z.object({authorization:z.unknown(),projectId:z.string().max(100)}).parse(await readJSON(request,12000)),args=authorization(body.authorization);
  if(!(await listProjects()).some(project=>project.id===body.projectId))throw new CloudHTTPError('المشروع غير موجود.',404);
  const code=randomBytes(32).toString('base64url');
  await cloudQuery('chatgpt_codes','','POST',{code_hash:digest(code),client_id:args.client_id,redirect_uri:args.redirect_uri,challenge:args.code_challenge,project_id:body.projectId,expires_at:new Date(Date.now()+300000).toISOString()});
  const redirect=new URL(args.redirect_uri);redirect.searchParams.set('code',code);redirect.searchParams.set('state',args.state);redirect.searchParams.set('iss',chatgptOrigin());return json({redirect:redirect.href});
 }
 if(action==='token'&&request.method==='POST'){
  const body=Object.fromEntries(new URLSearchParams((await readBytes(request,16000)).toString()));
  const id=z.string().max(6000).parse(body.client_id);client(id);
  if(body.resource!==chatgptResource())return json({error:'invalid_target'},400);
  const access='imoc_'+randomBytes(32).toString('base64url'),refresh=randomBytes(32).toString('base64url');
  const next={access_hash:digest(access),refresh_hash:digest(refresh),expires_at:new Date(Date.now()+3600000).toISOString()};
  if(body.grant_type==='authorization_code'){
   const code=z.string().regex(/^[\w-]{43}$/).parse(body.code),verifier=z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).parse(body.code_verifier),redirect=redirectSchema.parse(body.redirect_uri);
   if(!client(id).redirect_uris.includes(redirect))return json({error:'invalid_grant'},400);
   const challenge=createHash('sha256').update(verifier).digest('base64url');
   // Atomic conditional consumption prevents code replay and PKCE races.
   const rows=await cloudQuery<{project_id:string}[]>('chatgpt_codes',`code_hash=eq.${digest(code)}&client_id=eq.${eq(id)}&redirect_uri=eq.${eq(redirect)}&challenge=eq.${challenge}&expires_at=gt.${eq(new Date().toISOString())}`,'DELETE');
   if(!rows.length)return json({error:'invalid_grant'},400);
   await cloudQuery('chatgpt_connections','','POST',{id:randomUUID(),project_id:rows[0].project_id,client_id:id,...next,refresh_expires_at:new Date(Date.now()+30*86400000).toISOString()});
  }else if(body.grant_type==='refresh_token'){
   const old=z.string().regex(/^[\w-]{43}$/).parse(body.refresh_token);
   const rows=await cloudQuery('chatgpt_connections',`refresh_hash=eq.${digest(old)}&client_id=eq.${eq(id)}&revoked_at=is.null&refresh_expires_at=gt.${eq(new Date().toISOString())}`,'PATCH',next);
   if(!rows.length)return json({error:'invalid_grant'},400);
  }else return json({error:'unsupported_grant_type'},400);
  return json({access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:chatgptScope});
 }
 if(action==='connections'){
  if(!await cloudIsAdmin(request))throw new CloudHTTPError('دخول الإدارة مطلوب.',401);
  if(request.method==='GET'){const [rows,projects]=await Promise.all([cloudQuery('chatgpt_connections','select=id,project_id,created_at,revoked_at&order=created_at.desc'),listProjects()]);return json(rows.map(row=>({...row,projectName:projects.find(project=>project.id===row.project_id)?.name??'المشروع'})));}
  if(request.method!=='DELETE'||!cloudSameOrigin(request))throw new CloudHTTPError('Invalid origin',403);
  const {id}=z.object({id:z.string().uuid()}).parse(await readJSON(request));
  await cloudQuery('chatgpt_connections',`id=eq.${id}`,'PATCH',{revoked_at:new Date().toISOString()});return json({ok:true});
 }
 throw new CloudHTTPError('Not found',404);
}
