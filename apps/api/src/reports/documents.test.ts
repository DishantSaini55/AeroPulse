import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import type { Server } from 'node:http';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDb,type Database } from '../db.js';
import { createApp } from '../app.js';
import type { AuthProvider,PublicUser } from '../auth.js';
import { createReportFixture,cleanupReportFixture } from './test-fixtures.js';
import { documentTypes,reportTitles,reportLimits,reportWindow,validateDocumentSize,type ReportDocument,type DocumentFilter,ReportError } from './document-model.js';
import { renderReportPdf } from './pdf.js';
import { ReportGate } from './document-routes.js';

const db=process.env.DATABASE_URL?createDb():undefined,users=new Map<string,PublicUser>();
const auth:AuthProvider={login:async()=>null,verifyToken:async token=>users.get(token)??null};
let fixture:Awaited<ReturnType<typeof createReportFixture>>,server:Server,base='';
const extraUsers:string[]=[];
before(async()=>{
  if(process.env.REPORT_SAMPLE_DIR)await mkdir(process.env.REPORT_SAMPLE_DIR,{recursive:true});
  if(!db)return;
  fixture=await createReportFixture(db);users.set('supervisor',fixture.supervisor);users.set('engineer',fixture.engineer);
  server=createApp(db,undefined,auth).listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');base='http://127.0.0.1:'+address.port;
});
after(async()=>{
  if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(db){if(fixture)await cleanupReportFixture(db,[fixture.system.id,fixture.foreignSystem.id],[...fixture.userIds,...extraUsers]);await db.$disconnect();}
});
const filters=(type:DocumentFilter['type']='health')=>({type,from:fixture.from,to:fixture.to,system:fixture.system.code});
async function actor(){
  const user=await db!.user.create({data:{email:'report-case-'+crypto.randomUUID()+'@test.local',name:'Report case supervisor',role:'SUPERVISOR',passwordHash:'test'}});
  extraUsers.push(user.id);users.set(user.id,user);return user.id;
}
const call=(input:Record<string,unknown>,token='supervisor',origin=base)=>fetch(origin+'/api/v1/report-documents?'+new URLSearchParams(Object.entries(input).map(([key,value])=>[key,String(value)])),{headers:{authorization:'Bearer '+token}});
const documentJson=async(input:Record<string,unknown>,token:string)=>{
  const response=await call({...input,format:'json'},token);assert.equal(response.status,200,await response.clone().text());return await response.json() as ReportDocument;
};
async function pdfText(data:Uint8Array){
  const task=getDocument({data:new Uint8Array(data),useSystemFonts:false}),pdf=await task.promise;
  try{
    const pages=[];
    for(let index=1;index<=pdf.numPages;index++){
      const page=await pdf.getPage(index),content=await page.getTextContent();
      const text=content.items.map(item=>'str'in item?item.str:'').join(' ');
      const viewport=page.getViewport({scale:1});assert.ok(Math.abs(viewport.width-595.28)<1);assert.ok(Math.abs(viewport.height-841.89)<1);
      pages.push(text);
    }
    return pages;
  }finally{await task.destroy();}
}

test('document catalog and selections enforce authentication and backend supervisor authorization',{skip:!db},async()=>{
  for(const path of ['/catalog','/options?type=health&from='+fixture.from+'&to='+fixture.to,'?type=health&from='+fixture.from+'&to='+fixture.to]){
    assert.equal((await fetch(base+'/api/v1/report-documents'+path)).status,401);
    assert.equal((await fetch(base+'/api/v1/report-documents'+path,{headers:{authorization:'Bearer engineer'}})).status,403);
  }
  const catalog=await fetch(base+'/api/v1/report-documents/catalog',{headers:{authorization:'Bearer supervisor'}});
  assert.equal(catalog.status,200);assert.equal((await catalog.json() as {data:unknown[]}).data.length,10);
  const options=await fetch(base+'/api/v1/report-documents/options?'+new URLSearchParams(filters('completion')),{headers:{authorization:'Bearer supervisor'}});
  assert.equal(options.status,200);const value=await options.json() as {workOrders:{id:string}[]};
  assert.deepEqual(value.workOrders.map(order=>order.id),[fixture.order.id]);
});

test('all ten mounted report types produce parseable authoritative PDFs and awaited audit records',{skip:!db},async()=>{
  const deviceBefore=await db!.device.findUniqueOrThrow({where:{id:fixture.primary.id}});
  const histories=await db!.workOrderStatusHistory.count({where:{workOrderId:fixture.order.id}});
  for(const type of documentTypes){
    const token=await actor(),input={...filters(type),...(type==='completion'?{workOrderId:fixture.order.id}:{}),...(type==='incidents'?{incidentId:fixture.incident.id}:{})};
    const response=await call(input,token);assert.equal(response.status,200,await response.clone().text());
    assert.match(response.headers.get('content-type')??'',/^application\/pdf/);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.match(response.headers.get('content-disposition')??'',new RegExp('attachment; filename="aeropulse-'+type+'-.*\\.pdf"'));
    const id=response.headers.get('x-report-id')!;assert.match(id,/^AP-\d{8}-[a-f0-9-]+$/);
    const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(Buffer.from(bytes.subarray(0,5)).toString(),'%PDF-');assert.ok(bytes.length>1000);
    const pages=await pdfText(bytes),text=pages.join(' ');assert.ok(text.includes(reportTitles[type]));assert.ok(text.includes(fixture.system.code));
    for(const page of pages)if(page.includes('Authoritative work-order cost breakdown'))assert.ok(page.includes('Parts INR'),'A section heading must stay with its table header');
    assert.ok(text.includes('Report case supervisor'));assert.ok(!text.includes('OUTSIDE_SELECTED_REPORT'));assert.ok(text.includes('Independent simulated infrastructure'));
    assert.ok(text.includes(fixture.from));assert.ok(text.includes(fixture.to));assert.ok(!text.includes('passwordHash'));
    for(const [index,page] of pages.entries())assert.ok(page.includes(`Page ${index+1} of ${pages.length}`));
    const audit=await db!.auditEvent.findFirst({where:{actorId:token,path:{contains:id}}});assert.ok(audit);assert.equal(audit.method,'GET');assert.equal(audit.statusCode,200);
    if(process.env.REPORT_SAMPLE_DIR){await mkdir(process.env.REPORT_SAMPLE_DIR,{recursive:true});await writeFile(join(process.env.REPORT_SAMPLE_DIR,type+'.pdf'),bytes);}
  }
  assert.equal((await db!.device.findUniqueOrThrow({where:{id:fixture.primary.id}})).activationState,deviceBefore.activationState);
  assert.equal(await db!.workOrderStatusHistory.count({where:{workOrderId:fixture.order.id}}),histories,'Report reads must not alter maintenance state');
});

test('strict date, selector and cross-resource filters reject invalid or incompatible reports',{skip:!db},async()=>{
  const token=await actor(),baseFilter=filters('incidents');
  for(const input of [{...baseFilter,from:'2026-02-30'},{...baseFilter,from:'2026-12-02',to:'2026-01-01'},
    {...baseFilter,from:'2026-01-01',to:'2026-07-01'},{...baseFilter,type:'unknown'},{...baseFilter,format:'html'},
    {...baseFilter,workOrderId:fixture.order.id},{...baseFilter,incidentId:'not-an-id'},{...baseFilter,generatedBy:'spoofed'}])assert.equal((await call(input,token)).status,400);
  assert.equal((await call({...baseFilter,incidentId:fixture.incident.id,device:fixture.standby.code},token)).status,404);
  assert.equal((await call({...filters('completion'),workOrderId:fixture.pending.id},token)).status,404);
  assert.equal((await call({...filters('completion'),workOrderId:fixture.order.id,system:fixture.foreignSystem.code},token)).status,404);
  const scoped=await documentJson({...baseFilter,device:fixture.primary.code,incidentId:fixture.incident.id},token);
  assert.equal(scoped.sections[0]!.rows.length,1);assert.equal(scoped.sections[0]!.rows[0]!.incidentId,fixture.incident.id);
  const start=Date.parse('2001-01-15T00:00:00.000Z'),end=Date.parse('2001-01-16T00:00:00.000Z'),expected:string[]=[];
  for(const [index,at] of [start-1,start,end-1,end].entries()){
    const alarm=await db!.alarm.create({data:{sourceKey:fixture.marker+'-UTC-'+index,deviceId:fixture.primary.id,level:'WARNING',initialLevel:'WARNING',message:'UTC boundary fixture',createdAt:new Date(at)}});
    const incident=await db!.incident.create({data:{alarmId:alarm.id,deviceId:fixture.primary.id,priority:'LOW',description:'UTC boundary '+index,createdAt:new Date(at)}});
    if(index===1||index===2)expected.push(incident.id);
  }
  const boundary=await documentJson({...filters('incidents'),from:'2001-01-15',to:'2001-01-15'},await actor());
  assert.deepEqual(boundary.sections[0]!.rows.map(row=>row.incidentId).sort(),expected.sort(),'UTC start and final millisecond are included; adjacent dates are excluded');
});

test('completion snapshots, exact Decimal expenditure and recommendation evidence persist into report content',{skip:!db},async()=>{
  const token=await actor(),report=await documentJson({...filters('completion'),workOrderId:fixture.order.id},token);
  assert.equal(report.summary.find(row=>row.label==='Matched equipment')!.value,'1','A selected work order must narrow the equipment scope');
  const cost=report.sections.find(section=>section.title==='Authoritative work-order cost breakdown')!.rows[0]!;
  assert.equal(cost.parts,'0.30');assert.equal(cost.labor,'0.20');assert.equal(cost.other,'0.10');assert.equal(cost.total,'0.60');
  const checklist=report.sections.find(section=>section.title==='Historical checklist snapshot')!;
  assert.equal(checklist.rows.length,2);assert.ok(JSON.stringify(checklist.rows).includes('original connector'));
  assert.ok(JSON.stringify(checklist.rows).includes('सत्यापन पूरा'));
  const recommendations=await documentJson(filters('recommendations'),token),text=JSON.stringify(recommendations);
  assert.ok(text.includes('Loose connector'));assert.ok(text.includes('DETAILED_INVESTIGATION'));assert.ok(text.includes('spend INR 0.60'));
  const health=await documentJson(filters('health'),token);assert.ok(JSON.stringify(health).includes('37.25'));assert.ok(JSON.stringify(health).includes('No telemetry recorded'));
  await db!.heartbeat.createMany({data:Array.from({length:10},(_,index)=>({deviceId:fixture.standby.id,recordedAt:new Date(Date.now()-index*5000)}))});
  const systemReliability=await documentJson(filters('reliability'),token),deviceReliability=await documentJson({...filters('reliability'),device:fixture.primary.code},token);
  assert.deepEqual(deviceReliability.sections.find(section=>section.title==='Recorded service availability')!.rows,systemReliability.sections.find(section=>section.title==='Recorded service availability')!.rows,
    'Selecting one device must not lose its paired-device service coverage');
  assert.equal(deviceReliability.sections.find(section=>section.title==='Equipment reliability')!.rows.length,1);
  await db!.repairRecord.createMany({data:Array.from({length:999},()=>({incidentId:fixture.incident.id,actorId:fixture.engineer.id,action:'Isolated Decimal boundary coverage',cost:'9999999999.99'}))});
  const exact=await documentJson(filters('incidents'),token);
  assert.equal(exact.sections[0]!.rows[0]!.repairCostINR,'9990000000002.36','Report repair totals must preserve exact Decimal arithmetic at the supported cost boundary');
});

test('empty periods produce real PDF empty sections and CSV exports preserve escaping',{skip:!db},async()=>{
  const token=await actor();
  const response=await call({...filters('incidents'),from:'2000-01-01',to:'2000-01-01'},token);assert.equal(response.status,200);
  const bytes=new Uint8Array(await response.arrayBuffer()),pages=await pdfText(bytes);assert.ok(pages.join(' ').includes('No recorded data matches'));
  if(process.env.REPORT_SAMPLE_DIR)await writeFile(join(process.env.REPORT_SAMPLE_DIR,'empty.pdf'),bytes);
  await db!.maintenanceWorkOrder.update({where:{id:fixture.pending.id},data:{findings:'=HYPERLINK("malicious")'}});
  const csv=await call({...filters('expenditure'),workOrderId:fixture.pending.id,format:'csv'},token);assert.equal(csv.status,200);
  assert.match(csv.headers.get('content-type')??'',/text\/csv/);const content=await csv.text();assert.ok(content.includes("'=HYPERLINK"));assert.ok(content.includes('section'));
});

test('report data budgets reject oversized persisted datasets without silently truncating',{skip:!db},async()=>{
  const token=await actor();
  const rows=Array.from({length:1001},(_,index)=>({deviceId:fixture.primary.id,ruleCode:'REPORT_LIMIT_'+index,suspectedCause:'Isolated limit test',component:'Test',severity:'WARNING',
    symptoms:[],supportingTelemetry:{},serviceImpact:'Simulated',investigationSteps:[],recoveryAction:'None',detectedAt:new Date(),lastSeenAt:new Date()}));
  try{await db!.faultDiagnosis.createMany({data:rows});const response=await call({...filters('diagnostics'),format:'json'},token);
    assert.equal(response.status,413);assert.equal((await response.json() as {error:{code:string}}).error.code,'REPORT_TOO_LARGE');
  }finally{await db!.faultDiagnosis.deleteMany({where:{deviceId:fixture.primary.id,ruleCode:{startsWith:'REPORT_LIMIT_'}}});}
});

test('mounted concurrent requests are fenced and a failed audit releases report capacity',{skip:!db},async()=>{
  const token=await actor();let admitted!:()=>void,unblock!:()=>void;
  const entered=new Promise<void>(resolve=>{admitted=resolve;}),blocked=new Promise<void>(resolve=>{unblock=resolve;});
  let delay=true;
  const extended=db!.$extends({query:{device:{async findMany({args,query}){if(delay){delay=false;admitted();await blocked;}return query(args);}}}});
  const app=createApp(extended as unknown as Database,undefined,auth).listen(0,'127.0.0.1');await new Promise<void>(resolve=>app.once('listening',resolve));
  const address=app.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  try{
    const pending=call({...filters(),format:'json'},token,origin);await entered;
    const rejected=await call({...filters(),format:'json'},token,origin);assert.equal(rejected.status,429);
    assert.equal((await rejected.json() as {error:{code:string}}).error.code,'REPORT_BUSY');unblock();assert.equal((await pending).status,200);
  }finally{unblock();await new Promise<void>(resolve=>app.close(()=>resolve()));}
  let fail=true;
  const failed=db!.$extends({query:{auditEvent:{async create({args,query}){if(fail){fail=false;throw new Error('INJECTED_REPORT_AUDIT_FAILURE');}return query(args);}}}});
  const failureApp=createApp(failed as unknown as Database,undefined,auth).listen(0,'127.0.0.1');await new Promise<void>(resolve=>failureApp.once('listening',resolve));
  const failureAddress=failureApp.address();assert.ok(failureAddress&&typeof failureAddress!=='string');
  try{
    const origin='http://127.0.0.1:'+failureAddress.port;
    assert.equal((await call({...filters(),format:'json'},token,origin)).status,500);
    assert.equal((await call({...filters(),format:'json'},token,origin)).status,200);
  }finally{await new Promise<void>(resolve=>failureApp.close(()=>resolve()));}
});

test('authenticated report rate limit is enforced per user without blocking another user',{skip:!db},async()=>{
  const token=await actor();for(let index=0;index<12;index++)assert.equal((await call({...filters(),format:'json'},token)).status,200);
  const response=await call({...filters(),format:'json'},token);assert.equal(response.status,429);assert.ok(response.headers.get('retry-after'));
  assert.equal((await response.json() as {error:{code:string}}).error.code,'REPORT_RATE_LIMIT');
  assert.equal((await call({...filters(),format:'json'},await actor())).status,200);
});

test('multi-page PDF repeats headers, preserves long cells and Unicode, and retains complete final text',async()=>{
  const report:ReportDocument={id:'AP-LAYOUT-VERIFICATION',type:'completion',title:reportTitles.completion,generatedAt:'2026-11-27T00:00:00.000Z',
    generatedBy:{id:crypto.randomUUID(),name:'Layout verification actor',role:'SUPERVISOR'},filters:{type:'completion',from:'2026-11-26',to:'2026-11-27'},
    summary:[{label:'Dataset',value:'Explicit renderer test fixture'}],sections:[{title:'Long row verification',columns:[{key:'record',label:'Record key',weight:1},{key:'detail',label:'Recorded detail',weight:3}],
      rows:[{record:'LONG_ROW_START',detail:('समाप्ति सत्यापन ₹0.60. Long recorded maintenance verification text. ').repeat(110)+' LONG_ROW_END_TOKEN'},
        ...Array.from({length:95},(_,index)=>({record:'RECORD_'+index,detail:'Original snapshot '+index+'; '+('UNBROKENTOKEN').repeat(12)}))]}],notes:['Explicit isolated layout test, not operational airport data.'],rowCount:96,simulated:true};
  const pages=await pdfText(new Uint8Array(await renderReportPdf(report))),text=pages.join(' ');
  assert.ok(pages.length>=4);assert.ok(text.includes('LONG_ROW_END_TOKEN'));assert.ok(text.includes('RECORD_94'));assert.ok(text.includes('₹0.60'));
  assert.ok(pages.filter(page=>page.includes('Recorded detail')).length>=3);
  for(const [index,page] of pages.entries())assert.ok(page.includes(`Page ${index+1} of ${pages.length}`));
});

test('report window, global text budget and concurrency slots have deterministic bounded behavior',()=>{
  assert.throws(()=>reportWindow({type:'health',from:'2026-01-01',to:'2026-04-01',format:'pdf'}),ReportError);
  const gate=new ReportGate(2),release=gate.acquire('one'),other=gate.acquire('two');
  assert.throws(()=>gate.acquire('one'),/already running/);assert.throws(()=>gate.acquire('three'),/already running/);release();release();gate.acquire('three')();other();
  assert.throws(()=>validateDocumentSize({sections:[{title:'Too large',columns:[],rows:[{value:'x'.repeat(reportLimits.characters+1)}]}],rowCount:0} as unknown as ReportDocument),/text budget/);
});
