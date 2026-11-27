import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';

/** Isolated simulation fixtures shared by API, sample-file and real-browser verification. */
export async function createReportFixture(db:Database){
  const marker='PDF-'+randomUUID().slice(0,8).toUpperCase(),now=Date.now(),ago=(days:number)=>new Date(now-days*86400000);
  const supervisor=await db.user.create({data:{email:marker+'-supervisor@test.local',name:'PDF validation supervisor',role:'SUPERVISOR',passwordHash:'test'}});
  const engineer=await db.user.create({data:{email:marker+'-engineer@test.local',name:'PDF validation engineer',role:'MAINTENANCE_ENGINEER',passwordHash:'test'}});
  const system=await db.logicalSystem.create({data:{code:marker,name:marker+' report verification'}});
  const foreignSystem=await db.logicalSystem.create({data:{code:marker+'-X',name:marker+' outside selected scope'}});
  const primary=await db.device.create({data:{code:marker+'-P',name:'Report primary',systemId:system.id,role:'PRIMARY',activationState:'ACTIVE',commissionedAt:ago(90)}});
  const standby=await db.device.create({data:{code:marker+'-S',name:'Report standby',systemId:system.id,role:'SECONDARY',commissionedAt:ago(90)}});
  const foreign=await db.device.create({data:{code:marker+'-X-P',name:'OUTSIDE_SELECTED_REPORT',systemId:foreignSystem.id,role:'PRIMARY',activationState:'ACTIVE'}});
  await db.telemetryReading.create({data:{deviceId:primary.id,recordedAt:ago(.02),temperatureC:37.25,cpuPercent:21.5,packetLossPct:.1,simulated:true}});
  await db.heartbeat.createMany({data:[{deviceId:primary.id,recordedAt:ago(.02)},{deviceId:standby.id,recordedAt:ago(.02)}]});
  const faults=[];
  for(const day of [6,3,1])faults.push(await db.faultDiagnosis.create({data:{deviceId:primary.id,ruleCode:'MISSING_HEARTBEAT',suspectedCause:'Connector instability',component:'Network interface',severity:'MAJOR',
    symptoms:['Recorded heartbeat gap'],supportingTelemetry:{source:'isolated verification'},serviceImpact:'Simulated degradation',investigationSteps:['Inspect connector','Record verification evidence'],recoveryAction:'Confirm stable heartbeat',
    detectedAt:ago(day),firstObservedAt:new Date(ago(day).getTime()-5000),lastSeenAt:ago(day),resolvedAt:new Date(ago(day).getTime()+60000),confirmedRootCause:'Loose connector',confirmedById:supervisor.id,confirmedAt:ago(day)}}));
  const alarm=await db.alarm.create({data:{sourceKey:marker,deviceId:primary.id,diagnosisId:faults[0]!.id,level:'MAJOR',initialLevel:'MAJOR',message:marker+' simulated fault',createdAt:ago(6),resolvedAt:ago(5)}});
  const incident=await db.incident.create({data:{alarmId:alarm.id,deviceId:primary.id,status:'RESOLVED',priority:'HIGH',description:marker+' connector repair',assignedToId:engineer.id,
    createdAt:ago(6),acknowledgedAt:new Date(ago(6).getTime()+1000),repairStartedAt:new Date(ago(6).getTime()+10000),repairCompletedAt:new Date(ago(6).getTime()+60000),resolvedAt:ago(5),
    events:{create:{actorId:supervisor.id,kind:'VERIFIED',detail:'Isolated incident repair evidence',createdAt:ago(5)}},
    repairs:{create:{actorId:engineer.id,action:'Connector inspected and repaired',spareParts:['Connector'],cost:'12.35',createdAt:ago(6)}}}});
  const plan=await db.maintenancePlan.create({data:{name:marker+' preventive plan',deviceId:standby.id,systemId:system.id,category:'Inspection',description:'Isolated scheduled inspection',checklist:['Inspect connector'],frequency:'WEEKLY',
    advanceNoticeDays:7,estimatedDurationMinutes:30,createdById:supervisor.id,updatedById:supervisor.id,nextScheduledAt:ago(.01)}});
  const order=await db.maintenanceWorkOrder.create({data:{occurrenceKey:'report:'+randomUUID(),title:marker+' completed corrective work',description:'Recorded isolated maintenance completion',type:'CORRECTIVE',priority:'HIGH',status:'COMPLETED',
    deviceId:primary.id,systemId:system.id,incidentId:incident.id,assignedEngineerId:engineer.id,supervisorId:supervisor.id,estimatedDurationMinutes:30,createdAt:ago(6),scheduledStartAt:ago(5.1),
    actualStartAt:ago(5.1),maintenanceModeAt:ago(5.1),completedAt:ago(5),actualCompletionAt:ago(5),laborCost:'.20',otherCost:'.10',
    findings:('Connector and simulated signal path inspected. Original checklist snapshot retained. '+marker+' ').repeat(30),verificationResult:'Stable after recorded repair. सत्यापन पूरा. No active assignment was changed by reporting.',
    checklistItems:{create:[{description:'Inspect original connector',completed:true,result:'PASSED',remarks:'Verified original snapshot',completedAt:ago(5),completedById:engineer.id},
      {description:'Verify simulated heartbeat',completed:true,result:'PASSED',remarks:'सत्यापन पूरा',completedAt:ago(5),completedById:engineer.id}]},
    parts:{create:{partName:'Connector',partNumber:marker+'-CN',quantity:3,unitCost:'.10'}},transitions:{create:[
      {fromStatus:'ASSIGNED',toStatus:'IN_PROGRESS',actorId:engineer.id,note:'Authorized simulated start',createdAt:ago(5.1)},
      {fromStatus:'IN_PROGRESS',toStatus:'VERIFICATION',actorId:engineer.id,note:'Recorded post-maintenance verification',createdAt:ago(5.01)},
      {fromStatus:'VERIFICATION',toStatus:'COMPLETED',actorId:supervisor.id,note:'Approved standby eligibility restoration',createdAt:ago(5)},
    ]}}});
  const pending=await db.maintenanceWorkOrder.create({data:{occurrenceKey:'report:'+randomUUID(),title:marker+' preventive work',description:'Preventive work is not a failure',type:'PREVENTIVE',priority:'LOW',status:'ASSIGNED',
    deviceId:standby.id,systemId:system.id,planId:plan.id,assignedEngineerId:engineer.id,scheduledStartAt:ago(.01),estimatedDurationMinutes:30}});
  for(const [action,day,fromDeviceId,toDeviceId] of [
    ['PLANNED_MAINTENANCE',5.1,primary.id,standby.id],['MANUAL_FAILBACK',4.99,standby.id,primary.id],['AUTOMATIC_FAILOVER',1,primary.id,standby.id],['MANUAL_FAILBACK',.99,standby.id,primary.id],
  ] as const)await db.failoverEvent.create({data:{systemId:system.id,fromDeviceId,toDeviceId,initiatedById:supervisor.id,action,result:'SUCCESS',reason:marker+' isolated recorded switch',
    detectedAt:ago(day),completedAt:new Date(ago(day).getTime()+1000),durationMs:1000,simulated:true}});
  return {marker,supervisor,engineer,system,foreignSystem,primary,standby,foreign,incident,plan,order,pending,
    from:ago(7).toISOString().slice(0,10),to:new Date().toISOString().slice(0,10),userIds:[supervisor.id,engineer.id]};
}
export async function cleanupReportFixture(db:Database,systems:string[],users:string[]){
  const where={systemId:{in:systems}},children={workOrder:where};
  await db.workOrderChecklistItem.deleteMany({where:children});await db.workOrderPartUsage.deleteMany({where:children});await db.workOrderStatusHistory.deleteMany({where:children});
  await db.maintenanceWorkOrder.deleteMany({where});await db.maintenancePlan.deleteMany({where});await db.failoverEvent.deleteMany({where});
  const incidentWhere={device:where};
  await db.incidentEvent.deleteMany({where:{incident:incidentWhere}});await db.repairRecord.deleteMany({where:{incident:incidentWhere}});
  await db.deviceReplacement.deleteMany({where:{device:where}});await db.incident.deleteMany({where:incidentWhere});
  await db.alarmAcknowledgement.deleteMany({where:{alarm:{device:where}}});await db.alarm.deleteMany({where:{device:where}});
  await db.recommendationDecision.deleteMany({where:{device:where}});await db.faultDiagnosis.deleteMany({where:{device:where}});
  await db.telemetryReading.deleteMany({where:{device:where}});await db.heartbeat.deleteMany({where:{device:where}});
  await db.device.deleteMany({where});await db.logicalSystem.deleteMany({where:{id:{in:systems}}});
  await db.auditEvent.deleteMany({where:{actorId:{in:users}}});await db.user.deleteMany({where:{id:{in:users}}});
}
