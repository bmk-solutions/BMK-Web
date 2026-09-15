import {chatgptOAuth} from '@/lib/imo3d/cloud/chatgpt-auth';
import {chatgptMCP,chatgptDrafts} from '@/lib/imo3d/cloud/chatgpt-mcp';
import {cloudEnabled} from '@/lib/imo3d/cloud/client';
import {cloudFailure,fail} from '@/lib/imo3d/cloud/http';
export const runtime='nodejs';
export const maxDuration=60;
async function handle(request:Request,{params}:{params:Promise<{action:string}>}){
 if(!cloudEnabled())return fail('ربط ChatGPT متاح على المنصة المنشورة.',503);
 try{const {action}=await params;return action==='mcp'?await chatgptMCP(request):action==='drafts'?await chatgptDrafts(request):await chatgptOAuth(request,action);}catch(error){return cloudFailure(error);}
}
export {handle as GET,handle as POST,handle as PATCH,handle as DELETE};
