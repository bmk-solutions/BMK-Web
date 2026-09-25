import type {Metadata} from "next";
import TourViewer from "@/components/imo3d/TourViewer";
import {tourShareMetadata} from "@/lib/imo3d/cloud/share-metadata";
type Props={params:Promise<{id:string}>;searchParams:Promise<{embed?:string;scene?:string}>};
/** A shared link previews the project's tour under the developer's name, never the marketing site. */
export async function generateMetadata({params}:Props):Promise<Metadata>{const {id}=await params;return tourShareMetadata(id);}
export default async function Page({params,searchParams}:Props){const [{id},query]=await Promise.all([params,searchParams]);return <TourViewer id={id} embedded={query.embed==="1"} initialSceneId={typeof query.scene==="string"?query.scene:undefined}/>;}
