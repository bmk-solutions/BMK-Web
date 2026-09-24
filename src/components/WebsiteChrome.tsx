"use client";
import {usePathname} from "next/navigation";
import Script from "next/script";
export default function WebsiteChrome({header,footer,children}:{header:React.ReactNode;footer:React.ReactNode;children:React.ReactNode}){
  const pathname=usePathname();
  // Under the suite basePath the studio is the root and tours are /t/<id> (rewritten to /imo3d/...).
  if(pathname==="/"||pathname.startsWith("/t/")||pathname==="/imo3d"||pathname.startsWith("/imo3d/"))return <>{children}</>;
  return <>{header}{children}{footer}<Script src="/assets/js/site.js" strategy="afterInteractive"/></>;
}
