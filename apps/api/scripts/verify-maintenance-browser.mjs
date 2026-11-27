import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import express from 'express';
import { SignJWT } from 'jose';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://aeropulse_test:aeropulse_test@127.0.0.1:55432/aeropulse_test?schema=public';
assert.equal(new URL(process.env.DATABASE_URL).hostname,'127.0.0.1');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/aeropulse_test');
const { createDb } = await import('../dist/db.js');
const { createApp } = await import('../dist/app.js');
const { AuthService } = await import('../dist/auth.js');
const { RedundancyManager } = await import('../dist/failover/manager.js');
const { MaintenanceService } = await import('../dist/maintenance/service.js');
const { TelemetrySimulator } = await import('../dist/simulator/service.js');
const { attachRealtime } = await import('../dist/realtime.js');
const db = createDb();
const marker = 'Browser-' + crypto.randomUUID().slice(0,8);
const secret = crypto.randomUUID() + crypto.randomUUID();
let browser, cdp, server, io, simulator, systemId;
const pending = new Map();
let sequence = 0, injection;
const errors = [];
const until = async (label, check, timeout = 30000) => {
  const deadline = Date.now()+timeout;
  while (Date.now()<deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve,100)); }
  throw new Error('Timed out: '+label);
};
function send(method,params={}) {
  const id = ++sequence;
  return new Promise((resolve,reject) => { pending.set(id,{resolve,reject}); cdp.send(JSON.stringify({id,method,params})); });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
  return result.result.value;
}
const waitText = text => until(text,()=>evaluate('!!document.body && document.body.innerText.includes('+JSON.stringify(text)+')'));
async function fill(selector,value) {
  await until(selector,()=>evaluate('!!document.querySelector('+JSON.stringify(selector)+')'));
  await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});const proto=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(String(value))});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function click(selector) {
  await until('enabled '+selector,()=>evaluate('!!document.querySelector('+JSON.stringify(selector)+') && !document.querySelector('+JSON.stringify(selector)+').disabled'));
  await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
}
async function button(text) {
  await until('enabled button '+text,()=>evaluate(`[...document.querySelectorAll('button')].some(element=>element.textContent.trim()===${JSON.stringify(text)}&&!element.disabled)`));
  await evaluate(`(()=>{const element=[...document.querySelectorAll('button')].find(element=>element.textContent.trim()===${JSON.stringify(text)});if(!element||element.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});element.click();})()`);
}
let origin;
async function captureOverview() {
  const layout=await send('Page.getLayoutMetrics'), content=layout.cssContentSize??layout.contentSize;
  const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:content.width,height:Math.min(content.height,16000),scale:1}});
  await writeFile(resolve('../../docs/maintenance-workspace-browser-2026-11-27.png'),Buffer.from(screenshot.data,'base64'));
}
async function navigate(path,token) {
  if (injection) await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection});
  injection = (await send('Page.addScriptToEvaluateOnNewDocument',{source:'sessionStorage.setItem("aeropulse-token",'+JSON.stringify(token)+');'})).identifier;
  await send('Page.navigate',{url:origin+path});
}
try {
  const system = await db.logicalSystem.create({data:{code:marker.toUpperCase(),name:marker}}); systemId=system.id;
  const primary = await db.device.create({data:{systemId,code:system.code+'-P',name:'Browser primary',role:'PRIMARY',activationState:'ACTIVE'}});
  const secondary = await db.device.create({data:{systemId,code:system.code+'-S',name:'Browser standby',role:'SECONDARY'}});
  const supervisor = await db.user.create({data:{email:marker+'-supervisor@test.local',name:'Browser Supervisor',role:'SUPERVISOR',passwordHash:'test'}});
  const engineer = await db.user.create({data:{email:marker+'-engineer@test.local',name:'Browser Engineer',role:'MAINTENANCE_ENGINEER',passwordHash:'test'}});
  const token = async user => new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setIssuer('aeropulse').setAudience('aeropulse-web').setExpirationTime('30m').sign(new TextEncoder().encode(secret));
  const supervisorToken = await token(supervisor), engineerToken = await token(engineer);
  const auth = new AuthService(db,secret);
  const policy = {expectedIntervalMs:5000,missedHeartbeatLimit:3,timeoutMs:15000};
  const manager = new RedundancyManager(db,policy,event=>{io.emit('status:changed',event);io.emit('maintenance:changed',event);});
  const web = express();
  const apiApp=createApp(db,undefined,auth,undefined,policy,manager,undefined,undefined,undefined,undefined,()=>io.emit('maintenance:changed',{simulated:true}));
  web.use((request,response,next)=>request.path.startsWith('/api/')?apiApp(request,response,next):next());
  const dist = resolve('../web/dist');
  web.use(express.static(dist));
  web.use((_request,response)=>response.sendFile(join(dist,'index.html')));
  server=createServer(web); io=attachRealtime(server,auth);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin='http://127.0.0.1:'+server.address().port;
  simulator=new TelemetrySimulator(db,5000,event=>io.emit('telemetry:batch',event)); simulator.start();
  const tcp=createTcpServer(); await new Promise(resolve=>tcp.listen(0,'127.0.0.1',resolve));
  const debugPort=tcp.address().port; await new Promise(resolve=>tcp.close(resolve));
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'; await access(edge);
  const profile=await mkdtemp(join(tmpdir(),'aeropulse-maintenance-browser-'));
  browser=spawn(edge,['--headless=new','--no-first-run','--no-default-browser-check','--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort,'about:blank'],{windowsHide:true,stdio:'ignore'});
  await until('browser debugging endpoint',async()=>{try{return (await fetch('http://127.0.0.1:'+debugPort+'/json/version')).ok;}catch{return false;}},60000);
  const target=await (await fetch('http://127.0.0.1:'+debugPort+'/json/new?about:blank',{method:'PUT'})).json();
  cdp=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{cdp.addEventListener('open',resolve,{once:true});cdp.addEventListener('error',reject,{once:true});});
  cdp.addEventListener('message',event=>{
    const result=JSON.parse(event.data);
    if(result.id){const waiting=pending.get(result.id);if(waiting){pending.delete(result.id);result.error?waiting.reject(new Error(JSON.stringify(result.error))):waiting.resolve(result.result);}}
    if(result.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true});
    if(result.method==='Runtime.exceptionThrown')errors.push(result.params.exceptionDetails.exception?.description??result.params.exceptionDetails.text);
    if(result.method==='Network.responseReceived' && result.params.response.url.startsWith(origin+'/api/v1/maintenance/announcements') && result.params.response.status>=400)
      errors.push('Maintenance announcement HTTP '+result.params.response.status);
  });
  cdp.addEventListener('close',()=>{for(const waiting of pending.values())waiting.reject(new Error('Browser debugging connection closed'));pending.clear();});
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  // Real Edge/React/REST/Socket integration with instrumented audio APIs, not physical playback.
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__apAudio = { spoken: [], tones: 0 };
    const gain = () => ({ gain: { value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){return this;}, disconnect(){} });
    window.AudioContext = class { constructor(){this.state='suspended';this.currentTime=0;} async resume(){this.state='running';} async close(){this.state='closed';} createGain(){return gain();} createOscillator(){return {frequency:{value:0},connect(){return gain();},start(){window.__apAudio.tones++;},stop(){}};} };
    Object.defineProperty(window,'speechSynthesis',{value:{getVoices(){return [];},addEventListener(){},removeEventListener(){},cancel(){},speak(utterance){window.__apAudio.spoken.push(utterance.text);setTimeout(()=>utterance.onend?.(),5);}}});
  `});
  if(process.argv.includes('--overview-only')) {
    await navigate('/maintenance',supervisorToken);await waitText('Calculation definitions and denominators');
    await captureOverview();assert.deepEqual(errors,[]);console.log('OVERVIEW VISUAL CHECK CAPTURED');
  } else {
  await navigate('/maintenance/plans/new',supervisorToken);await waitText('Create maintenance plan');
  await fill('input[name="name"]',marker);await fill('select[name="deviceId"]',primary.id);await fill('select[name="engineer"]',engineer.id);
  await fill('textarea[name="description"]','Browser verified preventive maintenance');
  await fill('textarea[name="checklist"]','Inspect cooling assembly\nConfirm navigation signal');
  await button('Save plan');await waitText('Maintenance plans');
  await until('authenticated browser Socket.IO connection',async()=>io.sockets.sockets.size>0);
  const plan=await db.maintenancePlan.findFirstOrThrow({where:{name:marker,createdById:supervisor.id}});
  assert.equal(plan.deviceId,primary.id);assert.equal(plan.assignedEngineerId,engineer.id);
  console.log('PASS browser creates persisted recurring plan with device, engineer and checklist');
  await db.maintenancePlan.update({where:{id:plan.id},data:{nextScheduledAt:new Date(Date.now()-1000)}});
  await new MaintenanceService(db).generateDue();io.emit('maintenance:changed',{simulated:true});
  const order=await db.maintenanceWorkOrder.findFirstOrThrow({where:{planId:plan.id}});
  await navigate('/maintenance/orders/'+order.id,supervisorToken);await waitText('Assignment and cancellation');
  await fill('select[name="engineer"]',engineer.id);await button('Assign engineer');
  await until('engineer assignment',async()=>(await db.maintenanceWorkOrder.findUniqueOrThrow({where:{id:order.id}})).status==='ASSIGNED');
  await navigate('/maintenance/orders/'+order.id,engineerToken);await waitText('Confirm planned failover and start');
  assert.deepEqual(await evaluate('window.__apAudio.spoken'),[], 'Audio must wait for explicit activation');
  await click('button[aria-label="Alarm audio preferences"]');await button('Enable audio');
  await button('Confirm planned failover and start');
  await until('maintenance start',async()=>(await db.maintenanceWorkOrder.findUniqueOrThrow({where:{id:order.id}})).status==='IN_PROGRESS');
  assert.equal((await db.device.findUniqueOrThrow({where:{id:secondary.id}})).activationState,'ACTIVE');
  assert.equal((await db.logicalSystem.findUniqueOrThrow({where:{id:systemId}})).availability,'AVAILABLE');
  await until('browser maintenance start voice reconciled',()=>evaluate('window.__apAudio.spoken.some(text=>text.includes('+JSON.stringify(primary.code)+') && text.includes("maintenance started"))'));
  await until('browser committed planned switch voice',()=>evaluate('window.__apAudio.spoken.some(text=>text.includes('+JSON.stringify(system.code)+') && text.includes("planned maintenance switch"))'));
  const startNotices = await evaluate('window.__apAudio.spoken.filter(text=>text.includes('+JSON.stringify(primary.code)+') && text.includes("maintenance started"))');
  assert.equal(startNotices.length,1,'One committed start must be voiced only once');
  console.log('PASS real Edge announcement REST/Socket integration, explicit audio activation and start/switch deduplication (instrumented audio)');
  console.log('PASS assigned engineer starts safe planned failover while service stays available');
  const tasks=await db.workOrderChecklistItem.findMany({where:{workOrderId:order.id},orderBy:{id:'asc'}});
  assert.equal(tasks.length,2);
  await until('rendered checklist items',()=>evaluate("document.querySelectorAll('[data-checklist-id]').length===2"));
  const initialTaskOrder=await evaluate("[...document.querySelectorAll('[data-checklist-id]')].map(element=>element.dataset.checklistId)");
  for(const [index,item] of tasks.entries()){
    const form='form[data-checklist-id="'+item.id+'"]';
    await fill(form+' select[name="result"]','PASSED');await fill(form+' textarea[name="remarks"]','Verified inspection evidence');
    await click(form+' button');
    await until('checklist persisted',async()=>await db.workOrderChecklistItem.count({where:{workOrderId:order.id,completed:true}})===index+1);
    await until('checklist UI reconciled',()=>evaluate('document.querySelector('+JSON.stringify(form)+').querySelector("small").innerText.includes("UTC")'));
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-checklist-id]')].map(element=>element.dataset.checklistId)"),initialTaskOrder);
  }
  await fill('textarea[name="findings"]','Cooling and navigation assembly inspected, safe for verification');await button('Save findings');await waitText('Saved. Authoritative state refreshed.');
  await fill('form.maintenance-part:last-of-type input[name="name"]','Browser spare bearing');
  await fill('form.maintenance-part:last-of-type input[name="quantity"]','3');await fill('form.maintenance-part:last-of-type input[name="cost"]','0.10');await button('Add part');
  await until('part persisted',async()=>await db.workOrderPartUsage.count({where:{workOrderId:order.id}})===1);
  await waitText('Update part');
  await fill('form.maintenance-part:first-of-type input[name="quantity"]','4');await button('Update part');
  await until('part update persisted',async()=>(await db.workOrderPartUsage.findFirstOrThrow({where:{workOrderId:order.id}})).quantity===4);
  await button('Delete part');await until('part deletion persisted',async()=>await db.workOrderPartUsage.count({where:{workOrderId:order.id}})===0);
  await until('deleted part reconciled',()=>evaluate("document.querySelectorAll('form.maintenance-part').length===1"));
  await fill('form.maintenance-part:last-of-type input[name="name"]','Final browser bearing');await fill('form.maintenance-part:last-of-type input[name="quantity"]','3');await fill('form.maintenance-part:last-of-type input[name="cost"]','0.10');await button('Add part');
  await until('final part persisted',async()=>await db.workOrderPartUsage.count({where:{workOrderId:order.id}})===1);
  await fill('input[name="labor"]','0.20');await fill('input[name="other"]','0.10');await button('Save labor and other costs');
  await until('cost update',async()=>Number((await db.maintenanceWorkOrder.findUniqueOrThrow({where:{id:order.id}})).laborCost)===.2);
  const costs=await (await fetch(origin+'/api/v1/maintenance/work-orders/'+order.id+'/costs',{headers:{authorization:'Bearer '+engineerToken}})).json();assert.equal(costs.data.total,.6);
  for(const socket of io.sockets.sockets.values())socket.conn.close();
  const remoteCost=await fetch(origin+'/api/v1/maintenance/work-orders/'+order.id+'/costs',{method:'PATCH',headers:{authorization:'Bearer '+supervisorToken,'content-type':'application/json'},body:JSON.stringify({laborCost:.2,otherCost:.15})});
  assert.equal(remoteCost.status,200);
  await until('browser socket reconnects',async()=>io.sockets.sockets.size>0);
  await waitText('0.65');
  await fill('input[name="other"]','0.10');await button('Save labor and other costs');
  await until('restored browser cost entry',async()=>Number((await db.maintenanceWorkOrder.findUniqueOrThrow({where:{id:order.id}})).otherCost)===.1);
  console.log('PASS browser reconnect reconciles missed authoritative cost state through REST');
  await fill('select[name="passed"]','true');await fill('form:has(select[name="passed"]) textarea[name="remarks"]','All inspections passed and maintenance evidence verified');await button('Submit verification');
  await until('verification persisted',async()=>(await db.maintenanceWorkOrder.findUniqueOrThrow({where:{id:order.id}})).status==='VERIFICATION');
  const forbidden=await fetch(origin+'/api/v1/maintenance/work-orders/'+order.id+'/approve',{method:'POST',headers:{authorization:'Bearer '+engineerToken,'content-type':'application/json'},body:'{}'});assert.equal(forbidden.status,403);
  console.log('PASS browser checklist, findings, Decimal costs and verification; direct engineer approval denied');
  await navigate('/maintenance/orders/'+order.id,supervisorToken);await waitText('Approve and complete maintenance');
  await button('Approve and complete maintenance');
  await until('completion persisted',async()=>(await db.maintenanceWorkOrder.findUniqueOrThrow({where:{id:order.id}})).status==='COMPLETED');
  assert.equal((await db.device.findUniqueOrThrow({where:{id:primary.id}})).activationState,'STANDBY');
  await navigate('/redundancy',supervisorToken);await waitText(marker);
  await click('section[data-system="'+system.code+'"] .redundancy-actions button');
  await until('manual failback from browser',async()=>(await db.device.findUniqueOrThrow({where:{id:primary.id}})).activationState==='ACTIVE');
  assert.equal((await db.device.findUniqueOrThrow({where:{id:primary.id}})).activationState,'ACTIVE');
  await navigate('/maintenance',supervisorToken);await waitText('Calculation definitions and denominators');await waitText('0.60');
  await captureOverview();
  await navigate('/maintenance/calendar',supervisorToken);await waitText(marker);
  await navigate('/devices/'+primary.code,supervisorToken);await waitText(primary.code+' work-order history');
  assert.ok(await db.workOrderStatusHistory.count({where:{workOrderId:order.id}})>=5);
  assert.deepEqual(errors,[]);
  console.log('PASS supervisor approval, standby restoration, manual failback, analytics, calendar and device history');
  console.log('BROWSER WORKFLOW VERIFIED; screenshot docs/maintenance-workspace-browser-2026-11-27.png');
  }
} catch(error) {console.error(error);if(cdp?.readyState===WebSocket.OPEN)console.error(await evaluate('document.body.innerText').catch(()=>''));process.exitCode=1;}
finally {
  if(cdp?.readyState===WebSocket.OPEN)await send('Browser.close').catch(()=>{});
  cdp?.close();if(browser&&!browser.killed)browser.kill();
  await simulator?.stop();
  if(io)await new Promise(resolve=>io.close(resolve));
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  if(systemId){
    const where={systemId};
    await db.workOrderChecklistItem.deleteMany({where:{workOrder:where}});await db.workOrderPartUsage.deleteMany({where:{workOrder:where}});await db.workOrderStatusHistory.deleteMany({where:{workOrder:where}});
    await db.maintenanceWorkOrder.deleteMany({where});await db.maintenancePlan.deleteMany({where});await db.failoverEvent.deleteMany({where});
    await db.alarm.deleteMany({where:{device:where}});await db.faultDiagnosis.deleteMany({where:{device:where}});await db.telemetryReading.deleteMany({where:{device:where}});await db.heartbeat.deleteMany({where:{device:where}});
    await db.device.deleteMany({where});await db.logicalSystem.delete({where:{id:systemId}});
  }
  await db.$disconnect();
}
