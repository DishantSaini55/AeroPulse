import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { io as clientIo, type Socket } from 'socket.io-client';
import { createDb, type Database } from '../db.js';
import { createApp } from '../app.js';
import { attachRealtime } from '../realtime.js';
import type { PublicUser, AuthProvider } from '../auth.js';
import { MaintenanceService } from './service.js';
import { maintenanceAnnouncements, type MaintenanceAnnouncement } from './announcements.js';

const db = process.env.DATABASE_URL ? createDb() : undefined;
const users = new Map<string,PublicUser>();
const auth: AuthProvider = { login: async () => null, verifyToken: async token => users.get(token) ?? null };
const systems: string[] = [];
const server = createServer();
let io: ReturnType<typeof attachRealtime>, base = '';
const sockets: Socket[] = [];
const call = (path: string, method = 'GET', body?: unknown, token = 'supervisor') => fetch(base+'/api/v1/'+path, {
  method, headers: { authorization:'Bearer '+token, 'content-type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const feed = async (token = 'supervisor') => {
  const response = await call('maintenance/announcements','GET',undefined,token); assert.equal(response.status,200);
  return (await response.json() as { data:MaintenanceAnnouncement[] }).data;
};
before(async () => {
  if (!db) return;
  for (const [token,role] of [['supervisor','SUPERVISOR'],['engineer','MAINTENANCE_ENGINEER'],['other','MAINTENANCE_ENGINEER']] as const) {
    users.set(token,await db.user.create({ data: { email:'notice-'+crypto.randomUUID()+'@test.local',name:'Notice '+token,role,passwordHash:'test' } }));
  }
  server.on('request',createApp(db,undefined,auth,undefined,undefined,undefined,undefined,undefined,undefined,undefined,()=>io.emit('maintenance:changed',{ simulated:true })));
  io = attachRealtime(server,auth);
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string'); base = 'http://127.0.0.1:'+addr.port;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  if (io) await new Promise<void>(resolve => io.close(()=>resolve()));
  if (!db) return;
  const where = { systemId: { in:systems } };
  await db.workOrderChecklistItem.deleteMany({ where:{workOrder:where} });
  await db.workOrderPartUsage.deleteMany({ where:{workOrder:where} });
  await db.workOrderStatusHistory.deleteMany({ where:{workOrder:where} });
  await db.maintenanceWorkOrder.deleteMany({ where });
  await db.maintenancePlan.deleteMany({ where });
  await db.failoverEvent.deleteMany({ where });
  await db.recommendationDecision.deleteMany({ where:{device:where} });
  await db.faultDiagnosis.deleteMany({ where:{device:where} });
  await db.heartbeat.deleteMany({ where:{device:where} });
  await db.device.deleteMany({ where });
  await db.logicalSystem.deleteMany({ where:{id:{in:systems}} });
  await db.auditEvent.deleteMany({ where:{ actorId:{in:[...users.values()].map(user=>user.id)} } });
  await db.user.deleteMany({ where:{id:{in:[...users.values()].map(user=>user.id)}} });
  await db.$disconnect();
});
async function fixture() {
  const code = 'NOTICE-'+crypto.randomUUID().slice(0,8).toUpperCase();
  const system = await db!.logicalSystem.create({ data:{code,name:code} }); systems.push(system.id);
  const primary = await db!.device.create({ data:{ code:code+'-P',name:code+' primary',systemId:system.id,role:'PRIMARY',activationState:'ACTIVE' } });
  const standby = await db!.device.create({ data:{ code:code+'-S',name:code+' standby',systemId:system.id,role:'SECONDARY' } });
  const order = await db!.maintenanceWorkOrder.create({ data:{ occurrenceKey:crypto.randomUUID(),title:'Notice workflow',description:'Committed notice evidence',
    type:'PREVENTIVE',priority:'MEDIUM',status:'SCHEDULED',deviceId:primary.id,systemId:system.id,estimatedDurationMinutes:30,
    checklistItems:{ create:{description:'Verify connector'} } },include:{checklistItems:true} });
  return {system,primary,standby,order};
}
test('mounted announcement feed requires authentication, validates bounds and exposes no credentials', {skip:!db}, async () => {
  assert.equal((await call('maintenance/announcements','GET',undefined,'invalid')).status,401);
  for (const query of ['since=invalid','since=2000-01-01T00:00:00.000Z','since=2099-01-01T00:00:00.000Z','extra=true'])
    assert.equal((await call('maintenance/announcements?'+query)).status,400);
  const response = await call('maintenance/announcements'); assert.equal(response.headers.get('cache-control'),'no-store');
  const text = await response.text(); assert.ok(!text.includes('passwordHash')); assert.ok(!text.includes('@test.local'));
  const f=await fixture();
  assert.equal((await call('maintenance/work-orders/'+f.order.id+'/cancel','POST',{reason:'Unsafe start rejected: text supplied as a cancellation reason'})).status,200);
  assert.equal((await feed()).filter(row=>row.systemCode===f.system.code).length,0,'Free-form cancellation text must not fabricate a safety event');
});
test('upcoming and overdue notices use stable occurrence IDs, UTC dates and persisted active schedules', {skip:!db}, async () => {
  const f = await fixture(), at = new Date(), due = new Date(at.getTime()+86400000);
  const plan = await new MaintenanceService(db!).createPlan({name:'Upcoming evidence',deviceId:f.primary.id,description:'Plan due evidence',category:'Check',checklist:['Original'],
    frequency:'WEEKLY',advanceNoticeDays:2,estimatedDurationMinutes:30,priority:'LOW'},users.get('supervisor')!.id);
  await db!.maintenancePlan.update({ where:{id:plan.id},data:{nextScheduledAt:due} });
  const read = async (time = at) => (await maintenanceAnnouncements(db!,users.get('supervisor')!,new Date(time.getTime()-120000),time)).data.filter(row=>row.systemCode===f.system.code);
  const first = (await read()).find(row=>row.kind==='UPCOMING')!; assert.ok(first); assert.match(first.message,/UTC/);
  assert.equal((await read()).find(row=>row.kind==='UPCOMING')!.id,first.id);
  await db!.maintenanceWorkOrder.update({where:{id:f.order.id},data:{planId:plan.id,scheduledStartAt:due}});
  assert.equal((await read()).filter(row=>row.kind==='UPCOMING').length,1);
  const overdue = await read(new Date(due.getTime()+1)); assert.equal(overdue.filter(row=>row.kind==='OVERDUE').length,1);
  await db!.maintenanceWorkOrder.update({where:{id:f.order.id},data:{status:'CANCELLED'}});
  await db!.maintenancePlan.update({where:{id:plan.id},data:{active:false}});
  assert.equal((await read()).length,0);
  await db!.maintenancePlan.update({where:{id:plan.id},data:{active:true,nextScheduledAt:new Date(Date.now()-1000),assignedEngineerId:users.get('engineer')!.id}});
  await new MaintenanceService(db!).generateDue();
  assert.equal((await read(new Date())).filter(row=>row.kind==='ASSIGNED').length,1,'A committed recurring occurrence with a preassigned engineer must announce assignment');
});
test('unsafe start persists warning without success; committed lifecycle and planned switch reconcile after socket reconnect', {skip:!db}, async () => {
  const f = await fixture(), path = 'maintenance/work-orders/'+f.order.id;
  const socket = clientIo(base,{transports:['websocket'],auth:{token:'supervisor'},reconnection:false}); sockets.push(socket);
  await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
  let signals = 0; socket.on('maintenance:changed',()=>signals++);
  assert.equal((await call(path+'/assign','POST',{engineerId:users.get('engineer')!.id})).status,200);
  assert.equal((await call(path+'/start','POST',{},'other')).status,403);
  assert.equal((await call(path+'/start','POST',{},'engineer')).status,409);
  let notices = (await feed()).filter(row=>row.systemCode===f.system.code);
  assert.equal(notices.filter(row=>row.kind==='UNSAFE_START_REJECTED').length,1);
  assert.equal(notices.filter(row=>['STARTED','PLANNED_FAILOVER'].includes(row.kind)).length,0);
  assert.equal((await feed('other')).filter(row=>row.systemCode===f.system.code && row.kind==='UNSAFE_START_REJECTED').length,0);
  assert.equal((await db!.device.findUniqueOrThrow({where:{id:f.primary.id}})).activationState,'ACTIVE');
  await db!.heartbeat.createMany({data:[f.primary,f.standby].map(device=>({deviceId:device.id}))});
  socket.disconnect();
  assert.equal((await call(path+'/start','POST',{},'engineer')).status,200);
  const reconnected = new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
  socket.connect(); await reconnected;
  // Deliberately miss the socket signal; the REST feed must reconstruct committed outcomes.
  notices = (await feed()).filter(row=>row.systemCode===f.system.code);
  assert.equal(notices.filter(row=>row.kind==='STARTED').length,1);
  assert.equal(notices.filter(row=>row.kind==='PLANNED_FAILOVER').length,1);
  assert.ok(notices.every(row=>['INFORMATION','WARNING'].includes(row.level)));
  assert.equal((await call(path+'/verify','POST',{passed:false,remarks:'Connector still unstable'},'engineer')).status,200);
  assert.ok((await feed()).some(row=>row.systemCode===f.system.code && row.kind==='VERIFICATION_FAILED'));
  assert.equal((await call(path+'/checklist/'+f.order.checklistItems[0]!.id,'PATCH',{result:'PASSED'},'engineer')).status,200);
  assert.equal((await call(path+'/verify','POST',{passed:true,remarks:'Stable verification completed'},'engineer')).status,200);
  assert.ok((await feed()).some(row=>row.systemCode===f.system.code && row.kind==='APPROVAL_REQUESTED'));
  assert.equal((await feed('engineer')).filter(row=>row.systemCode===f.system.code && row.kind==='APPROVAL_REQUESTED').length,0);
  assert.equal((await call(path+'/reject','POST',{reason:'Verification failed: supervisor requests clearer documentation'})).status,200);
  assert.equal((await feed()).filter(row=>row.systemCode===f.system.code && row.kind==='VERIFICATION_FAILED').length,1,'Supervisor rejection text must not fabricate another failed equipment verification');
  assert.equal((await call(path+'/verify','POST',{passed:true,remarks:'Reverified after documentation review'},'engineer')).status,200);
  await db!.heartbeat.create({data:{deviceId:f.primary.id}});
  assert.equal((await call(path+'/approve','POST',{})).status,200);
  notices = (await feed()).filter(row=>row.systemCode===f.system.code);
  assert.equal(notices.filter(row=>row.kind==='COMPLETED').length,1); assert.equal(notices.filter(row=>row.kind==='ELIGIBILITY_RESTORED').length,1);
  assert.equal((await db!.device.findUniqueOrThrow({where:{id:f.primary.id}})).activationState,'STANDBY');
  const alarmCount = await db!.alarm.count({where:{device:{systemId:f.system.id}}}); assert.equal(alarmCount,0);
  assert.ok(signals>=1,'Authenticated socket received committed assignment invalidation');
});
test('failed transaction cannot produce success announcements or advance equipment state', {skip:!db}, async () => {
  const f = await fixture();
  await db!.heartbeat.createMany({data:[f.primary,f.standby].map(device=>({deviceId:device.id}))});
  const injected = db!.$extends({query:{auditEvent:{async create({args,query}){await query(args);throw new Error('NOTICE_ROLLBACK');}}}});
  const app = createApp(injected as unknown as Database,undefined,auth).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>app.once('listening',resolve));
  try {
    const addr=app.address();assert.ok(addr && typeof addr!=='string');
    const result=await fetch('http://127.0.0.1:'+addr.port+'/api/v1/maintenance/work-orders/'+f.order.id+'/start',{method:'POST',headers:{authorization:'Bearer supervisor','content-type':'application/json'},body:'{}'});
    assert.equal(result.status,500);
    assert.equal((await feed()).filter(row=>row.systemCode===f.system.code).length,0);
    assert.equal((await db!.device.findUniqueOrThrow({where:{id:f.primary.id}})).activationState,'ACTIVE');
  } finally {await new Promise<void>(resolve=>app.close(()=>resolve()));}
});

test('mounted recommendations use persisted verified maintenance, exact costs and stale-evidence supervisor authorization', {skip:!db}, async () => {
  const f = await fixture(), now = Date.now(), ago = (days:number)=>new Date(now-days*86400000);
  await db!.faultDiagnosis.createMany({data:[10,5].map(days=>({deviceId:f.primary.id,ruleCode:'NETWORK',suspectedCause:'Connector',component:'Network interface',severity:'MAJOR',
    symptoms:['Packet loss'],supportingTelemetry:{},serviceImpact:'Simulated degradation',investigationSteps:['Inspect connector'],recoveryAction:'Verify repaired connector',
    detectedAt:ago(days),lastSeenAt:ago(days),resolvedAt:new Date(ago(days).getTime()+60000),confirmedRootCause:'Loose connector'}))});
  const recommendation = async () => {
    const response=await call('recommendations');assert.equal(response.status,200);
    return (await response.json() as {data: {deviceId:string;causeKey:string;evidenceHash:string;action:string;similarFailures:number;repairCost:number;
      maintenance:{expenditure:string;verifiedCompletions:number;failuresAfterCorrective:number}}[]}).data.find(row=>row.deviceId===f.primary.id)!;
  };
  const before=await recommendation();assert.equal(before.action,'PREVENTIVE_MAINTENANCE');
  await db!.maintenanceWorkOrder.update({where:{id:f.order.id},data:{type:'CORRECTIVE',status:'COMPLETED',actualStartAt:ago(16),maintenanceModeAt:ago(16),completedAt:ago(15),
    verificationResult:'Persisted stable verification',findings:'Repaired connector',laborCost:'.20',otherCost:'.10',checklistItems:{update:{where:{id:f.order.checklistItems[0]!.id},data:{completed:true,result:'PASSED'}}},
    parts:{create:{partName:'Connector',quantity:3,unitCost:'.10'}}}});
  const after=await recommendation();assert.equal(after.action,'DETAILED_INVESTIGATION');assert.equal(after.similarFailures,2);
  assert.equal(after.maintenance.expenditure,'0.60');assert.equal(after.maintenance.failuresAfterCorrective,2);
  assert.equal(after.maintenance.verifiedCompletions,1);assert.equal(after.repairCost,0);
  const decision=(row:typeof before)=>({deviceId:row.deviceId,causeKey:row.causeKey,evidenceHash:row.evidenceHash,decision:'APPROVED',note:'Review confirmed maintenance evidence'});
  assert.equal((await call('recommendations/decisions','POST',decision(before))).status,409);
  assert.equal((await call('recommendations/decisions','POST',decision(after),'engineer')).status,403);
  assert.equal((await call('recommendations/decisions','POST',decision(after))).status,201);
  assert.equal((await db!.device.findUniqueOrThrow({where:{id:f.primary.id}})).activationState,'ACTIVE','Recommendation decisions must not activate or replace devices');
});

test('bounded announcement snapshot tolerates a slow database read beyond Prisma default without HTTP 500', {skip:!db}, async () => {
  const delayed = db!.$extends({query:{workOrderStatusHistory:{async findMany({args,query}){
    await new Promise(resolve=>setTimeout(resolve,5200));
    return query(args);
  }}}});
  const app=createApp(delayed as unknown as Database,undefined,auth).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>app.once('listening',resolve));
  try {
    const addr=app.address();assert.ok(addr && typeof addr!=='string');
    const response=await fetch('http://127.0.0.1:'+addr.port+'/api/v1/maintenance/announcements',{headers:{authorization:'Bearer supervisor'}});
    assert.equal(response.status,200);assert.ok(Array.isArray((await response.json() as {data:unknown[]}).data));
  } finally {await new Promise<void>(resolve=>app.close(()=>resolve()));}
});
