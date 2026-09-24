import {withBasePath} from "@/lib/imo3d/base-path";
export async function api<T>(path:string,options?:RequestInit):Promise<T> {
  const response=await fetch(withBasePath(`/api/imo3d/${path}`),{...options,cache:"no-store",headers:{...(options?.body instanceof FormData?{}:{"Content-Type":"application/json"}),...options?.headers}});
  const body=await response.json();if(!response.ok)throw Error(body.error??"تعذر الاتصال بالنظام");return body;
}
export const number=(value:number)=>new Intl.NumberFormat("ar-SA",{maximumFractionDigits:0}).format(value);
