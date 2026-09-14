"use client";
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState} from "react";
import {prepareLogoPixels} from "./logo-pixels";
import "./brand-logo.css";

type Result={src:string;monochrome:boolean};
const cache=new Map<string,Promise<Result>>();
function processedLogo(src:string,clean:boolean){
  const key=`${clean}:${src}`;let pending=cache.get(key);if(pending)return pending;
  pending=new Promise<Result>((resolve,reject)=>{const image=new Image();image.onload=()=>{try{
    const ratio=Math.min(1,1024/Math.max(image.naturalWidth,image.naturalHeight)),width=Math.max(1,Math.round(image.naturalWidth*ratio)),height=Math.max(1,Math.round(image.naturalHeight*ratio));
    const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const context=canvas.getContext("2d",{willReadFrequently:true});if(!context)throw Error("Canvas unavailable");context.drawImage(image,0,0,width,height);
    const pixels=context.getImageData(0,0,width,height),crop=prepareLogoPixels(pixels.data,width,height,clean);context.putImageData(pixels,0,0);
    const output=document.createElement("canvas");output.width=crop.width;output.height=crop.height;output.getContext("2d")!.drawImage(canvas,crop.x,crop.y,crop.width,crop.height,0,0,crop.width,crop.height);
    resolve({src:output.toDataURL("image/png"),monochrome:clean&&crop.monochrome&&crop.hasTransparentBorder});
  }catch(error){reject(error);}};image.onerror=()=>reject(Error("Logo unavailable"));image.src=src;});
  cache.set(key,pending);if(cache.size>24)cache.delete(cache.keys().next().value!);pending.catch(()=>cache.delete(key));return pending;
}
export function BrandLogo({src,alt="",clean=true,tone="original",className=""}:{src:string;alt?:string;clean?:boolean;tone?:"original"|"light";className?:string}){
  const [result,setResult]=useState<{source:string;clean:boolean;value:Result}|null>(null);
  useEffect(()=>{let alive=true;processedLogo(src,clean).then(value=>{if(alive)setResult({source:src,clean,value});}).catch(()=>{});return()=>{alive=false;};},[src,clean]);
  const ready=result?.source===src&&result.clean===clean?result.value:null;
  return <img src={ready?.src||src} alt={alt} className={`imo-fitted-logo ${ready?.monochrome&&tone==="light"?"imo-fitted-logo--light":""} ${className}`} data-logo-ready={!!ready}/>;
}
