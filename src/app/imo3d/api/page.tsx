import Link from "next/link";
import {IMO3D_BASE_PATH} from "@/lib/imo3d/base-path";

const endpoints=[
  ["GET","/projects","المشاريع المسموحة للمفتاح"],
  ["GET","/projects/:id/usage","حجم الصور والشعار وزمن المهام المسجّل بصلاحية read"],
  ["POST","/tours","إنشاء جولة: projectId وtitle"],
  ["POST","/tours/:id/images","رفع صورة 360 عبر multipart باسم file مع floor اختياري"],
  ["POST","/tours/:id/processing","بدء الربط والتقدير المكاني بعد رفع الدفعة"],
  ["GET","/tours/:id/processing","التقدم والنتيجة والتنبيهات"],
  ["GET","/tours/:id","الصور والمخطط والهوية وrevision"],
  ["PATCH","/tours/:id","تعديل الاسم أو النشر مع revision الحالي"],
  ["DELETE","/tours/:id/scenes/:sceneId","حذف صورة وروابطها مع revision الحالي"],
  ["POST","/tours/:id/connections","ربط صورتين يدويًا مع اتجاه الذهاب والعودة"],
  ["DELETE","/tours/:id/connections","فك الرابط ومنع إعادته تلقائيًا"],
  ["DELETE","/tours/:id","حذف الجولة ومحتوياتها مع revision الحالي"],
  ["GET","/tours/:id/embed","رابط الجولة وكود تضمينها بعد النشر"],
  ["GET","/leads?paged=1","طلبات الاهتمام المرقمة بصلاحية leads"],
];
export default function IntegrationGuide(){return <main className="imo-shell" style={{padding:"40px 24px"}}><article style={{maxWidth:950,margin:"auto"}}>
  <Link href="/" className="imo-button secondary">العودة إلى الاستوديو</Link>
  <p style={{marginTop:32,color:"#59716b"}}>IMO 3D · دليل التكامل</p><h1 style={{fontSize:32}}>جولاتك داخل موقعك أو منصتك</h1>
  <p>افتح إعدادات API للمشروع وأنشئ مفتاحًا بالصلاحيات المطلوبة. انسخه عند ظهوره، واحفظه على خادم منصتك. يمكنك إلغاؤه في أي وقت.</p>
  <pre dir="ltr" style={{background:"#142c26",color:"#e3f6ec",padding:20,borderRadius:12,overflowX:"auto"}}>{`Authorization: Bearer YOUR_API_KEY\nBase URL: https://YOUR_HOST${IMO3D_BASE_PATH}/api/imo3d`}</pre>
  <p>صلاحية read للقراءة، وwrite لإنشاء الجولات ورفع الصور والتعديل، وleads لقراءة طلبات العملاء. المفتاح مرتبط بمشروع واحد. استخدم read وwrite معًا لأتمتة الرفع.</p>
  <div style={{overflowX:"auto"}}><table className="imo-table" style={{width:"100%"}}><thead><tr><th>الطريقة</th><th>المسار</th><th>الاستخدام</th></tr></thead><tbody>{endpoints.map(([method,path,use])=><tr key={method+path}><td dir="ltr"><code>{method}</code></td><td dir="ltr"><code>{path}</code></td><td>{use}</td></tr>)}</tbody></table></div>
  <p>ارفع الصور بالتتابع داخل الجولة، ثم ابدأ المعالجة مرة واحدة. الصور بانورامية كاملة بنسبة 2:1، والحد 100 ميجابايت (MiB) للصورة مع دعم بانوراما 20K ضمن حد 268 مليون بكسل. يُحفظ الأصل دون إعادة ضغط، وتُجهز نسخة عرض عالية الجودة حتى 8K للأجهزة المناسبة مع نسخ أخف. تابع التقدم كل 2–5 ثوانٍ؛ حالة review تعني أن الناتج يحتاج مراجعة. تقدير الصور وحدها غير معاير بالمتر.</p>
  <p>عند التعديل أرسل revision من آخر قراءة. إذا وصل رد 409، أعد قراءة الجولة قبل إعادة التعديل.</p>
  <p>يمكن تحديد دور الصور أثناء الرفع باستخدام floor، أو تعديل أدوار اللقطات ضمن scenes مع revision. نقل صورة إلى دور آخر يُبطل معايرتها القديمة والروابط غير المناسبة؛ لا يلزم ملف كاميرات لتسمية الدور.</p>
  <p>لقراءة طلبات الاهتمام على صفحات، استخدم paged=1 مع limit اختياري؛ يعيد الطلب leads وtotal وnextCursor. أرسل nextCursor كما هو في cursor للصفحة التالية. مفتاح API يرى مشروعه فقط. حجم الصور وزمن المهام متاحان من usage، بينما نقل البيانات للزوار غير مقاس.</p>
  <p>للربط اليدوي أرسل fromId وtoId مع fromYaw وtoYaw بالدرجات واتجاه العالم، بالإضافة إلى revision. يجب أن تكون الصورتان في الدور نفسه. يمكنك تحديد الاتجاهين بصريًا من تبويب الربط اليدوي في الإدارة. حذف الرابط يمنع التحليل التلقائي من إعادته؛ ربط الصورتين يدويًا يعيد تفعيله.</p>
  <h2>العرض داخل صفحة العقار</h2><p>بعد إتاحة الجولة، انسخ كود التضمين من إعدادات API. تظهر الجولة باسمك وشعارك، ويعمل ملء الشاشة داخل الموقع الآخر. المفتاح يبقى على الخادم؛ لا تضعه داخل الصفحة أو رابط الجولة.</p>
  <pre dir="ltr" style={{background:"white",padding:20,borderRadius:12,overflowX:"auto"}}>{`<iframe src="https://YOUR_HOST${IMO3D_BASE_PATH}/t/TOUR_ID"\n  title="360 tour" width="100%" height="700"\n  style="border:0" allow="fullscreen" loading="lazy">\n</iframe>`}</pre>
  <p style={{color:"#63746e"}}>التوثيق الكامل وأمثلة الخادم ضمن المشروع: docs/imo3d/api.md</p>
  </article></main>;}
