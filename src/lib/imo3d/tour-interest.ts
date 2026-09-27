/**
 * The buyer's «سجّل اهتمامك» as the page shows it: whether it is offered, whom the consent
 * names, the developer's WhatsApp and the analytics beacon. The tour's server fills
 * `TourInterest` from VERA's context (vera-integration.ts); this file only reads it.
 *
 * Isomorphic: no Node or browser APIs.
 */
/** `bmkInbox`: VERA answered that this tour is unlinked, so a request goes to BMK's inbox. Absent = VERA's answer is not known. */
export type TourInterest={enabled:boolean;developerName:string|null;projectName:string|null;whatsapp:string|null;unitOffMarket:boolean;unitStatus:"sold"|"reserved"|"rented"|null;privacyUrl:string|null;beacon:string|null;bmkInbox?:boolean};
/** VERA's analytics kinds this tour sends. None carries a name, a phone or a message. */
export type TourBeaconKind="tour_view"|"wa_click"|"mortgage_use";

export const UNLINKED_CHIP="غير مربوط — الطلبات تذهب إلى صندوق BMK";
/** Where VERA sent a request, as the studio's lead list names it. */
export const ROUTED_LABELS={project:"مشروع مربوط في Developer OS",developer:"مطوّر مربوط في Developer OS",hint:"مطوّر المشروع في Developer OS",fallback:"صندوق BMK"} as const;
export const PHONE_HINT="رقم سعودي (05…) أو رقم دولي يبدأ بـ + أو 00";
export const PRIVACY_NOTE="لن تُستخدم بياناتك لغير هذا الغرض";

/** A tour without VERA's answer (local development, an older payload) keeps its button. */
export const interestOffered=(interest?:TourInterest|null)=>interest?.enabled!==false&&interest?.unitOffMarket!==true;

const OFF_MARKET_LABELS={sold:"مباعة",reserved:"محجوزة",rented:"مؤجّرة"} as const;
/** The status chip a sold, reserved or rented unit shows instead of an offer; null while it is on the market. */
export const offMarketLabel=(interest?:TourInterest|null)=>interest?.unitOffMarket?interest.unitStatus?OFF_MARKET_LABELS[interest.unitStatus]:"غير متاحة":null;

/** The project a buyer's request is about: the Developer OS project a link files it under, else the tour's own name. */
export const interestProjectName=(interest:TourInterest|null|undefined,tourProjectName:string)=>interest?.projectName?.trim()||tourProjectName;

/** The receiver of an unlinked tour's request, named as POI names it (VERA routes it to BMK Solutions). */
export const BMK_INBOX_RECEIVER="BMK Solutions (فريق مبيعات المشروع)";
/**
 * Who receives the name and phone: the linked developer; BMK Solutions when VERA said the tour is
 * unlinked; the project's sales team, unnamed, only while VERA's answer is not known.
 */
export const interestReceiver=(interest?:Pick<TourInterest,"developerName"|"bmkInbox">|null)=>interest?.developerName?.trim()||(interest?.bmkInbox?BMK_INBOX_RECEIVER:"فريق مبيعات المشروع");

/** PDPL consent: it names who receives the name and phone, and for what. */
export function consentText(developerName:string|null,projectName:string,bmkInbox=false){
 return `أوافق على إرسال اسمي ورقم جوالي إلى ${interestReceiver({developerName,bmkInbox})} للتواصل معي بخصوص ${projectName.trim()||"هذا المشروع"}.`;
}

/** wa.me link with a prefilled question about this unit; null when the number is not a plausible E.164 one. */
export function whatsappHref(number:string|null,projectName:string,unitCode:string){
 const digits=number?.replace(/\D/g,"")??"";if(!/^[1-9]\d{7,14}$/.test(digits))return null;
 const message=`مرحبًا، أرغب بالاستفسار عن ${unitCode?`الوحدة ${unitCode} في `:""}${projectName}.`;
 return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/**
 * VERA's events route is reached only from its own origin: the tour served through the suite
 * (os.bmk.solutions) shares it and its session cookie. An embed on the tour's own host skips it.
 */
export function beaconTarget(interest:TourInterest|null|undefined,pageOrigin:string){
 try{const url=new URL(interest?.beacon??"");return url.origin===pageOrigin?url.href:null;}catch{return null;}
}
export function beaconBody(kind:TourBeaconKind,tour:{id:string;projectId:string;unit:{code:string}}){
 return JSON.stringify({kind,app:"tour360",ref:tour.projectId,item:tour.id,...(tour.unit.code?{unit_code:tour.unit.code}:{})});
}
