import {resourceMetadata} from '@/lib/imo3d/cloud/chatgpt-auth';
export function GET(){return Response.json(resourceMetadata());}
