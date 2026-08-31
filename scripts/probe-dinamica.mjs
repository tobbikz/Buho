import { chromium } from 'playwright';
const B='http://127.0.0.1:3100';
const b=await chromium.launch({executablePath:process.env.PW_CHROME});
const p=await (await b.newContext({viewport:{width:1400,height:1000}})).newPage();
await p.goto(`${B}/login`,{waitUntil:'networkidle'});
for(let i=0;i<5;i++){await p.waitForTimeout(500);await p.fill('input[name=username]','tomy');await p.fill('input[name=password]','contrasena-larga-1');if(await p.inputValue('input[name=password]')==='contrasena-larga-1')break;}
await Promise.all([p.waitForURL(u=>new URL(u).pathname!=='/login'),p.click('button[type=submit]')]);
await p.goto(`${B}/instances/81/flow?dir=lectura&peso=calls&quien=aplicacion&vista=vivo`,{waitUntil:'networkidle'});
await p.waitForTimeout(8000);
// cuenta píxeles claros del canvas = densidad de partículas
const densidad=async()=>{
  let s=0;
  for(let k=0;k<6;k++){
    // Sólo la banda central: en los bordes están las etiquetas de texto, que
    // son píxeles claros fijos y ahogaban la señal de las partículas.
    s+=await p.evaluate(()=>{const c=document.querySelector('canvas');const x=c.getContext('2d');
      const x0=Math.floor(c.width*0.30), an=Math.floor(c.width*0.40);
      const d=x.getImageData(x0,0,an,c.height).data;let n=0;
      for(let i=0;i<d.length;i+=4){if(d[i]>170&&d[i+2]>170)n++;}return n;});
    await p.waitForTimeout(250);
  }
  return Math.round(s/6);
};
const rotulo=await p.evaluate(()=>{const t=document.body.innerText;const i=t.indexOf('EN VIVO');return i<0?'?':t.slice(i,i+140).split('\n').slice(0,3).join(' | ');});
const datos=await p.evaluate(async()=>{const r=await fetch(new URL(location.pathname,location.origin)&&'/api/flow-live?alcance=instancia&instancia=81&peso=calls&dir=lectura&quien=aplicacion',{cache:'no-store'});const j=await r.json();return {total:j.links.reduce((s,l)=>s+l.value,0), referencia:j.referenceRate};});
console.log(JSON.stringify({fase:process.env.FASE??'?', densidad:await densidad(), ...datos, rotulo}));
await p.screenshot({path:`/tmp/dinamica-${process.env.FASE??'x'}.png`});
await b.close();
