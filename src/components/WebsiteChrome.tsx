import Script from "next/script";
/** The marketing site's header, footer and script; only the (site) route group renders it. */
export default function WebsiteChrome({header,footer,children}:{header:React.ReactNode;footer:React.ReactNode;children:React.ReactNode}){
  return <>{header}{children}{footer}<Script src="/assets/js/site.js" strategy="afterInteractive"/></>;
}
