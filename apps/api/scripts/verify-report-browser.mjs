import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdir,mkdtemp,readFile,readdir,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import express from 'express';
import {SignJWT} from 'jose';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';

process.env.DATABASE_URL=process.env.TEST_DATABASE_URL??'postgresql://aeropulse_test:aeropulse_test@127.0.0.1:55432/aeropulse_test?schema=public';
const databaseUrl=new URL(process.env.DATABASE_URL);assert.equal(databaseUrl.hostname,'127.0.0.1');assert.equal(databaseUrl.pathname,'/aeropulse_test');
const {createDb}=await import('../dist/db.js'),{createApp}=await import('../dist/app.js'),{AuthService}=await import('../dist/auth.js');
const {attachRealtime}=await import('../dist/realtime.js');
const {createReportFixture,cleanupReportFixture}=await import('../dist/reports/test-fixtures.js');
const db=createDb(),secret=crypto.randomUUID()+crypto.randomUUID();
const downloads=resolve('../../docs/pdf-browser-downloads-2026-11-27',crypto.randomUUID());await mkdir(downloads,{recursive:true});
let fixture,server,io,browser,cdp,origin,sequence=0,tokenScript;
const pending=new Map(),errors=[];
let expectFilterError=false;
const until=async(label,check,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,150));}throw new Error('Timed out: '+label);};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});cdp.send(JSON.stringify({id,method,params}));});
async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
const waitText=text=>until(text,()=>evaluate('!!document.body && document.body.innerText.includes('+JSON.stringify(text)+')'));
async function fill(selector,value){
  await until('enabled '+selector,()=>evaluate('!!document.querySelector('+JSON.stringify(selector)+') && !document.querySelector('+JSON.stringify(selector)+').disabled'));
  await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});const proto=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(String(value))});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function click(selector){await until('enabled '+selector,()=>evaluate('!!document.querySelector('+JSON.stringify(selector)+') && !document.querySelector('+JSON.stringify(selector)+').disabled'));await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');}
async function button(label){await until('enabled '+label,()=>evaluate(`[...document.querySelectorAll('button')].some(item=>item.textContent.trim()===${JSON.stringify(label)}&&!item.disabled)`));await evaluate(`[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(label)}).click()`);}
async function screenshot(filename,width,height){
  await send('Page.bringToFront');
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
  await new Promise(resolve=>setTimeout(resolve,1500));
  const layout=await send('Page.getLayoutMetrics'),content=layout.cssContentSize??layout.contentSize;
  const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:content.width,height:Math.min(content.height,3200),scale:1}});
  await writeFile(resolve('../../docs/'+filename),Buffer.from(image.data,'base64'));
  const noOverflow=await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1');
  if(!noOverflow)console.error('Overflow diagnostics: '+JSON.stringify(await evaluate('[...document.querySelectorAll("body *")].map(element=>({tag:element.tagName,cls:element.className,rect:element.getBoundingClientRect().toJSON()})).filter(item=>item.rect.right>document.documentElement.clientWidth+1&&item.rect.width>0).slice(0,20)')));
  assert.ok(noOverflow,'Reporting workspace must not overflow horizontally');
}
async function download(action,extension){
  const before=new Set(await readdir(downloads));await action();let filename;
  await until('actual '+extension+' browser download',async()=>{filename=(await readdir(downloads)).find(file=>!before.has(file)&&file.endsWith(extension));return !!filename;});
  return {filename,bytes:await readFile(join(downloads,filename))};
}
async function parsedText(bytes){const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false}),pdf=await task.promise;try{let text='';for(let page=1;page<=pdf.numPages;page++){const content=await (await pdf.getPage(page)).getTextContent();text+=content.items.map(item=>'str'in item?item.str:'').join(' ')+' ';}return text;}finally{await task.destroy();}}
try{
  fixture=await createReportFixture(db);
  const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(fixture.supervisor.id).setIssuedAt().setIssuer('aeropulse').setAudience('aeropulse-web').setExpirationTime('30m').sign(new TextEncoder().encode(secret));
  const auth=new AuthService(db,secret),api=createApp(db,undefined,auth),web=express();
  const config=await readFile(resolve('../../infrastructure/nginx/default.conf'),'utf8');
  const csp=config.match(/add_header Content-Security-Policy "([^"]+)" always/)?.[1];assert.ok(csp?.includes("frame-src 'self' blob:"));
  web.use((_request,response,next)=>{response.setHeader('Content-Security-Policy',csp);next();});
  web.use((request,response,next)=>request.path.startsWith('/api/')?api(request,response,next):next());
  const dist=resolve('../web/dist');web.use(express.static(dist));web.use((_request,response)=>response.sendFile(join(dist,'index.html')));
  server=createServer(web);io=attachRealtime(server,auth);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  const tcp=tcpServer();await new Promise(resolve=>tcp.listen(0,'127.0.0.1',resolve));const debugPort=tcp.address().port;await new Promise(resolve=>tcp.close(resolve));
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';await access(edge);const profile=await mkdtemp(join(tmpdir(),'aeropulse-report-browser-'));
  browser=spawn(edge,['--headless=new','--no-first-run','--no-default-browser-check','--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort,'about:blank'],{windowsHide:true,stdio:'ignore'});
  await until('Edge debugging',async()=>{try{return(await fetch('http://127.0.0.1:'+debugPort+'/json/version')).ok;}catch{return false;}},60000);
  const target=await(await fetch('http://127.0.0.1:'+debugPort+'/json/new?about:blank',{method:'PUT'})).json();cdp=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{cdp.addEventListener('open',resolve,{once:true});cdp.addEventListener('error',reject,{once:true});});
  cdp.addEventListener('message',event=>{const result=JSON.parse(event.data);if(result.id){const handler=pending.get(result.id);if(handler){pending.delete(result.id);result.error?handler.reject(new Error(JSON.stringify(result.error))):handler.resolve(result.result);}}
    if(result.method==='Runtime.exceptionThrown')errors.push(result.params.exceptionDetails.exception?.description??result.params.exceptionDetails.text);
    if(result.method==='Network.responseReceived'&&result.params.response.url.startsWith(origin+'/api/v1/report-documents')&&result.params.response.status>=400&&!(expectFilterError&&result.params.response.status===400))errors.push('Report HTTP '+result.params.response.status);
    if(result.method==='Log.entryAdded'&&result.params.entry.source==='security'&&result.params.entry.level==='error')errors.push(result.params.entry.text);
  });
  cdp.addEventListener('close',()=>{for(const handler of pending.values())handler.reject(new Error('Browser debugging closed'));pending.clear();});
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Log.enable');
  // Observe the actual preview Blob without introducing a CSP-blocked fetch of its object URL.
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__reportBlobs=new Map();
    const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=create(blob);window.__reportBlobs.set(url,blob);return url;};
    URL.revokeObjectURL=url=>{window.__reportBlobs.delete(url);revoke(url);};
  `});
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  tokenScript=(await send('Page.addScriptToEvaluateOnNewDocument',{source:'sessionStorage.setItem("aeropulse-token",'+JSON.stringify(token)+');'})).identifier;
  await send('Page.navigate',{url:origin+'/reports'});await waitText('Infrastructure reports');
  await until('ten report type options',()=>evaluate('document.querySelectorAll("select[name=report-type] option").length===10'));
  await fill('input[name=from]',fixture.from);await fill('input[name=to]',fixture.to);await fill('select[name=report-type]','completion');
  await until('system choice',()=>evaluate('!!document.querySelector('+JSON.stringify('select[name=system] option[value="'+fixture.system.code+'"]')+')'));
  await fill('select[name=system]',fixture.system.code);
  await until('equipment choice',()=>evaluate('!!document.querySelector('+JSON.stringify('select[name=device] option[value="'+fixture.primary.code+'"]')+')'));
  await fill('select[name=device]',fixture.primary.code);
  assert.equal(await evaluate('document.querySelector("select[name=device]").value'),fixture.primary.code);
  await fill('input[name=record-search]',fixture.marker);
  await until('incident choice',()=>evaluate('!!document.querySelector('+JSON.stringify('select[name=incidentId] option[value="'+fixture.incident.id+'"]')+')'));
  await fill('select[name=incidentId]',fixture.incident.id);
  await until('work-order choice',()=>evaluate('!!document.querySelector('+JSON.stringify('select[name=workOrderId] option[value="'+fixture.order.id+'"]')+')'));
  await fill('select[name=workOrderId]',fixture.order.id);await button('Generate PDF');await until('actual PDF preview',()=>evaluate('document.querySelector("iframe.report-pdf-frame")?.src.startsWith("blob:")'));
  await waitText('GENERATED REPORT');
  const pdf=await download(()=>button('Download PDF'),'.pdf');assert.equal(pdf.bytes.subarray(0,5).toString(),'%PDF-');
  const content=await parsedText(pdf.bytes);assert.ok(content.includes(fixture.order.id));assert.ok(content.includes('0.60'));assert.ok(content.includes('Historical checklist snapshot'));assert.ok(content.includes('Equipment: '+fixture.primary.code));
  const browserHash=await evaluate('(async()=>{const blob=window.__reportBlobs.get(document.querySelector("iframe.report-pdf-frame").src);if(!blob)throw new Error("Preview Blob is no longer active");const data=await blob.arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest("SHA-256",data))].map(value=>value.toString(16).padStart(2,"0")).join("");})()');
  assert.equal(createHash('sha256').update(pdf.bytes).digest('hex'),browserHash,'Downloaded PDF must equal the preview snapshot byte for byte');
  const existingTargets=new Set((await send('Target.getTargets')).targetInfos.map(target=>target.targetId));
  await send('Runtime.evaluate',{expression:'document.querySelector(".report-document-preview a[target=_blank]").click()',userGesture:true});
  let popup;
  await until('open PDF preview tab',async()=>{popup=(await send('Target.getTargets')).targetInfos.find(target=>target.type==='page'&&!existingTargets.has(target.targetId)&&target.url!=='about:blank');return !!popup;});
  assert.ok(popup.url.startsWith('blob:')||popup.url.startsWith('chrome-extension:'));await send('Target.closeTarget',{targetId:popup.targetId});
  const csv=await download(()=>button('Download CSV'),'.csv');assert.ok(csv.bytes.toString('utf8').includes('0.60'));assert.ok(csv.bytes.toString('utf8').includes('Historical checklist snapshot'));
  console.log('PASS real Edge report selectors, generated PDF preview/download identity and CSV download: '+pdf.filename);
  await screenshot('pdf-report-workspace-mobile-2026-11-27.png',390,900);await screenshot('pdf-report-workspace-tablet-2026-11-27.png',768,1024);await screenshot('pdf-report-workspace-desktop-2026-11-27.png',1440,2000);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await fill('select[name=report-type]','incidents');await waitText('Filters have changed');
  assert.ok(await evaluate('[...document.querySelectorAll("button")].find(item=>item.textContent.trim()==="Download PDF").disabled'));
  await fill('input[name=record-search]','');
  await until('incident report selector',()=>evaluate('!!document.querySelector('+JSON.stringify('select[name=incidentId] option[value="'+fixture.incident.id+'"]')+')'));
  await fill('select[name=incidentId]',fixture.incident.id);
  assert.equal(await evaluate('document.querySelector("select[name=incidentId]").value'),fixture.incident.id);
  const oldId=await evaluate('document.querySelector(".report-document-preview h2").textContent');
  await button('Generate PDF');await until('new incident PDF',()=>evaluate('document.querySelector(".report-document-preview h2").textContent!=='+JSON.stringify(oldId)));
  expectFilterError=true;await fill('input[name=from]','2000-01-01');await waitText('at most 90 days');
  await fill('input[name=to]','2000-01-01');await until('valid empty-period options',()=>evaluate('!document.querySelector(".report-document-filters .form-error")'));
  expectFilterError=false;await button('Generate PDF');await waitText('No matching recorded rows');
  console.log('PASS stale-filter downloads blocked; incident selection, bounded-date error and empty-data PDF workflow');
  await click('.legacy-report-panel>summary');await waitText('Recorded activity reports');
  await fill('.legacy-report-panel select','failovers');const dates=await evaluate('[...document.querySelectorAll(".legacy-report-panel input[type=date]")].map(element=>element.value)');assert.equal(dates.length,2);
  await fill('.legacy-report-panel input[type=date]:first-of-type',fixture.from);
  await evaluate(`(()=>{const nodes=document.querySelectorAll('.legacy-report-panel input[type=date]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(nodes[1],${JSON.stringify(fixture.to)});nodes[1].dispatchEvent(new Event('input',{bubbles:true}));nodes[1].dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await fill('.legacy-report-panel input[placeholder="e.g. ILS-P"]',fixture.primary.code);await button('Generate');await until('legacy filtered result',()=>evaluate('document.querySelectorAll(".legacy-report-panel tbody tr").length===4'));
  const legacy=await download(()=>click('.legacy-report-panel .report-actions button[type=button]'),'.csv');assert.ok(legacy.bytes.toString('utf8').includes('PLANNED_MAINTENANCE'));
  assert.deepEqual(errors,[]);console.log('PASS legacy CSV submitted-date/device filters, browser downloads, responsive layout and CSP checks');
  console.log('REPORT BROWSER VERIFICATION PASSED');
}catch(error){console.error(error);console.error('Browser diagnostics: '+JSON.stringify(errors));if(cdp?.readyState===WebSocket.OPEN)console.error(await evaluate('document.body.innerText').catch(()=>''));process.exitCode=1;}
finally{
  if(cdp?.readyState===WebSocket.OPEN)await send('Browser.close').catch(()=>{});cdp?.close();if(browser&&!browser.killed)browser.kill();
  if(io)await new Promise(resolve=>io.close(()=>resolve()));else if(server)await new Promise(resolve=>server.close(()=>resolve()));
  if(fixture)await cleanupReportFixture(db,[fixture.system.id,fixture.foreignSystem.id],fixture.userIds);
  await db.$disconnect();
}
