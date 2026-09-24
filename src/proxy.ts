import {NextResponse,type NextRequest} from "next/server";
import {suiteLoginPath} from "./lib/imo3d/base-path";
import {localDevelopmentRequest,suiteSession} from "./lib/imo3d/suite";

/**
 * The admin pages open only inside the owner's studio-suite session. A signed-out visitor gets
 * a 307 to the suite's login with a RELATIVE Location: through os.bmk.solutions it stays on the
 * suite's host, and neither this deployment's nor the zone's own host reaches the address bar.
 * Public tours (/t/<id>) and the API guide are not matched; the API answers 401 JSON itself.
 */
export async function proxy(request:NextRequest){
  if(localDevelopmentRequest(request)||await suiteSession(request))return NextResponse.next();
  const url=new URL(request.url);
  // A same-host absolute URL is emitted as a relative Location by Next's proxy adapter.
  const response=NextResponse.redirect(new URL(suiteLoginPath(url.pathname+url.search),request.url),307);
  response.headers.set("Cache-Control","private, no-store");
  return response;
}

export const config={matcher:["/","/imo3d/connect-chatgpt"]};
