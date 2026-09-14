import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
const [source,output]=process.argv.slice(2);
if(!source||!output)throw new Error('Provide candidate JSON and output PNG');
const candidate=JSON.parse(await readFile(source,'utf8'));
const groups=[...new Set(candidate.rooms.map(r=>`${r.floor}/${r.component}`))];
const width=1050,height=120+groups.length*650;
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
let drawing=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#263630"/><g font-family="Arial" fill="white"><text x="525" y="40" text-anchor="middle" font-size="23">معاينة مستخرجة من الصور — غير معتمدة</text><text x="525" y="75" text-anchor="middle" font-size="16">المجموعات المنفصلة ليست مرتبطة مكانيًا · لا توجد أبعاد مترية مؤكدة</text>`;
for(let index=0;index<groups.length;index++){
 const rooms=candidate.rooms.filter(r=>`${r.floor}/${r.component}`===groups[index]);
 const points=rooms.flatMap(r=>r.outline),xs=points.map(p=>p.x),zs=points.map(p=>p.z);
 const minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
 const scale=Math.min(840/Math.max(.1,maxX-minX),540/Math.max(.1,maxZ-minZ));
 const dx=525-(minX+maxX)/2*scale,dy=155+index*650-minZ*scale;
 drawing+=`<text x="525" y="${120+index*650}" text-anchor="middle" font-size="16">مجموعة ${index+1} · ${rooms.length} فراغات مقترحة</text>`;
 for(const [roomIndex,room]of rooms.entries()){
  const p=room.outline.map(p=>`${(p.x*scale+dx).toFixed(2)},${(p.z*scale+dy).toFixed(2)}`).join(' ');
  drawing+=`<polygon points="${p}" fill="#ffffff0c" stroke="white" stroke-width="3" stroke-linejoin="miter"><title>${escape(room.id)}</title></polygon>`;
  const x=room.outline.reduce((a,p)=>a+p.x,0)/room.outline.length*scale+dx,y=room.outline.reduce((a,p)=>a+p.z,0)/room.outline.length*scale+dy;
  drawing+=`<text x="${x}" y="${y}" text-anchor="middle" font-size="16">${roomIndex+1}</text>`;
 }
}
drawing+='</g></svg>';
await writeFile(output.replace(/\.png$/i,'.svg'),drawing);
await sharp(Buffer.from(drawing)).png().toFile(output);
