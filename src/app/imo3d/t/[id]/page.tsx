import TourViewer from "@/components/imo3d/TourViewer";
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{embed?:string;scene?:string}>}){const [{id},query]=await Promise.all([params,searchParams]);return <TourViewer id={id} embedded={query.embed==="1"} initialSceneId={typeof query.scene==="string"?query.scene:undefined}/>;}
