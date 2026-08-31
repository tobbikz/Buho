import { chromium } from 'playwright';
const BASE='http://127.0.0.1:3100';
const b=await chromium.launch({executablePath:process.env.PW_CHROME});
const c=await b.newContext({viewport:{width:1500,height:1200}});
const p=await c.newPage();
const err=[]; p.on('pageerror',e=>err.push(String(e)));
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
for(let i=0;i<5;i++){await p.waitForTimeout(400+i*300);await p.fill('input[name="username"]','tomy');await p.fill('input[name="password"]','contrasena-larga-1');if(await p.inputValue('input[name="password"]')==='contrasena-larga-1')break;}
await Promise.all([p.waitForURL(u=>new URL(u).pathname!=='/login',{timeout:15000}),p.click('button[type="submit"]')]);
for(const [n,q] of [['flota escritura','?dir=escritura&peso=rows&v=7d'],['flota lectura app','?dir=lectura&peso=calls&v=1h&quien=aplicacion']]){
  let r=await p.goto(`${BASE}/flow${q}`,{waitUntil:'networkidle'});
  if((r?.status()??0)>=500){await p.waitForTimeout(2500);r=await p.goto(`${BASE}/flow${q}`,{waitUntil:'networkidle'});}
  await p.waitForTimeout(1200);
  const cintas=await p.locator('svg path.recharts-sankey-link').count();
  const filas=await p.locator('table.data-table tbody tr').count();
  console.log(`${r?.status()===200?'ok ':'FALLA'} ${n} http=${r?.status()} cintas=${cintas} filas=${filas} js=${err.length}`);
}
await p.goto(`${BASE}/flow?dir=lectura&peso=calls&v=1h&quien=aplicacion`,{waitUntil:'networkidle'});
await p.waitForTimeout(1500);
await p.screenshot({path:'/tmp/buho-fleet-flow.png',fullPage:true});
if(err.length) console.log(err.slice(0,3));
await b.close();
