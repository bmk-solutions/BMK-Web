import type {Metadata} from "next";
import {THEME_BOOT_SCRIPT} from "@/lib/imo3d/theme";
import {NEUTRAL_TOUR_ICON} from "@/lib/imo3d/share-card";
import {withBasePath} from "@/lib/imo3d/base-path";
import "./imo3d.css";
import "./imo3d-theme.css";
// Under the basePath: metadata icon URLs are not prefixed by Next, public files are.
export const metadata:Metadata={title:"IMO 3D — استوديو الجولات",robots:{index:false,follow:false},icons:{icon:withBasePath(NEUTRAL_TOUR_ICON)}};
// Before the first paint: a page that paints dark and then flips to light reads as a fault.
export default function Layout({children}:{children:React.ReactNode}){return <><script dangerouslySetInnerHTML={{__html:THEME_BOOT_SCRIPT}}/>{children}</>;}
