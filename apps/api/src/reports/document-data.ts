import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';
import { Prisma } from '../generated/prisma/client.js';
import { calculateReliability, type AnalyticsInput } from '../analytics/metrics.js';
import { calculateRecommendations, recommendationPolicy } from '../recommendations/policy.js';
import { reportRows } from './routes.js';
import { boundRows, ReportError, reportLimits, reportTitles, reportWindow, validateDocumentSize,
  type DocumentFilter, type ReportDocument, type ReportSection } from './document-model.js';
import type { ReportRow } from './csv.js';

type ReadDb = Prisma.TransactionClient;
const take = reportLimits.rows+1;
const dateText = (value: Date | null) => value?value.toISOString().replace('T',' ').replace('Z',' UTC'):null;
const duration = (value: number | null) => value == null ? 'Not available' : value<1000?value.toFixed(0)+' ms':value<60000?(value/1000).toFixed(2)+' s':value<3600000?(value/60000).toFixed(2)+' min':(value/3600000).toFixed(3)+' h';
const pct = (value: number | null) => value == null ? 'Not available' : value.toFixed(3)+'%';
const list = (value: unknown) => Array.isArray(value) ? value.map(String).join('; ') : value == null ? '' : JSON.stringify(value);
const columns = (items: [string,string,number?][]) => items.map(([key,label,weight])=>({key,label,weight}));
const costs = (order: { laborCost: Prisma.Decimal; otherCost: Prisma.Decimal; parts: { quantity: number; unitCost: Prisma.Decimal }[] }) => {
  const parts = order.parts.reduce((total,part)=>total.plus(part.unitCost.mul(part.quantity)),new Prisma.Decimal(0));
  return { parts:parts.toFixed(2),labor:order.laborCost.toFixed(2),other:order.otherCost.toFixed(2),total:parts.plus(order.laborCost).plus(order.otherCost).toFixed(2) };
};

export async function buildReportDocument(db: Database, filter: DocumentFilter, actor: PublicUser, at = new Date()) {
  reportWindow(filter);
  return db.$transaction(tx=>snapshot(tx,filter,actor,at),{isolationLevel:'RepeatableRead',maxWait:5000,timeout:20000});
}

async function snapshot(db: ReadDb, filter: DocumentFilter, actor: PublicUser, at: Date): Promise<ReportDocument> {
  const {from,to}=reportWindow(filter), date={gte:from,lt:to};
  const evidenceAt=new Date(Math.min(at.getTime(),to.getTime()-1));
  const selectedOrder=filter.workOrderId?await db.maintenanceWorkOrder.findUnique({where:{id:filter.workOrderId},select:{deviceId:true}}):null;
  const selectedIncident=filter.incidentId?await db.incident.findUnique({where:{id:filter.incidentId},select:{deviceId:true}}):null;
  if(filter.workOrderId&&!selectedOrder)throw new ReportError('NOT_FOUND','Work order not found',404);
  if(filter.incidentId&&!selectedIncident)throw new ReportError('NOT_FOUND','Incident not found',404);
  const selectedDeviceId=selectedOrder?.deviceId??selectedIncident?.deviceId;
  const devices=boundRows(await db.device.findMany({where:{id:selectedDeviceId,code:filter.device,system:filter.system?{code:filter.system}:undefined},take,
    orderBy:{code:'asc'},include:{system:{select:{code:true,name:true}},replacements:{where:{replacedAt:{lte:evidenceAt}},orderBy:{replacedAt:'desc'},take:1}}}));
  const ids=devices.map(device=>device.id), deviceWhere={id:{in:ids}};
  if (filter.device && !devices.length) throw new ReportError('NOT_FOUND','Equipment does not match the selected registry/system',404);
  if (filter.system && !await db.logicalSystem.count({where:{code:filter.system}})) throw new ReportError('NOT_FOUND','Logical system not found',404);
  if (filter.incidentId && !await db.incident.count({where:{id:filter.incidentId,deviceId:{in:ids},createdAt:filter.type==='incidents'?date:undefined}})) throw new ReportError('NOT_FOUND','Incident does not match the selected equipment, system or date range',404);
  if (filter.workOrderId && !await db.maintenanceWorkOrder.count({where:{id:filter.workOrderId,deviceId:{in:ids},incidentId:filter.incidentId}}))
    throw new ReportError('NOT_FOUND','Work order does not match the selected equipment, system or incident',404);
  const {format:_format,...reportFilters}=filter;
  const report:ReportDocument={id:'AP-'+at.toISOString().slice(0,10).replaceAll('-','')+'-'+randomUUID(),type:filter.type,title:reportTitles[filter.type],
    generatedAt:at.toISOString(),generatedBy:{id:actor.id,name:actor.name,role:actor.role},filters:reportFilters,
    summary:[],sections:[],notes:[
      'Independent simulated infrastructure monitoring demonstration. Not connected to operational airport equipment; no official AAI deployment or endorsement.',
      'UTC dates are inclusive. Records are selected by the event/cohort dates stated in each section. Current recorded outcomes are not historical time-travel snapshots.',
      'Missing observations and unknown metrics are reported explicitly; no operational airport measurements or predicted outcomes are fabricated.',
    ],rowCount:0,simulated:true};
  const add=(title:string,fields:[string,string,number?][],rows:ReportRow[],note?:string)=>{
    report.sections.push({title,columns:columns(fields),rows:boundRows(rows),note});
    validateDocumentSize(report);
  };
  const summary=(label:string,value:string|number)=>report.summary.push({label,value:String(value)});
  summary('Reporting period',filter.from+' to '+filter.to+' UTC');
  summary('Matched equipment',devices.length);

  if (['health','executive'].includes(filter.type)) {
    const observations=await db.device.findMany({where:deviceWhere,orderBy:{code:'asc'},take,include:{
      telemetry:{where:{recordedAt:date},take:1,orderBy:{recordedAt:'desc'}},heartbeats:{where:{recordedAt:date},take:1,orderBy:{recordedAt:'desc'}},
      _count:{select:{telemetry:{where:{recordedAt:date}},heartbeats:{where:{recordedAt:date}}}}}});
    summary('Telemetry records in period',observations.reduce((total,item)=>total+item._count.telemetry,0));
    summary('Currently healthy registry devices',devices.filter(device=>device.health==='HEALTHY').length);
    add('Equipment health and observations',[
      ['device','Equipment',1.2],['health','Registry health now',1],['observed','Period observations',1.8],['measurements','Latest recorded telemetry',2.2],
    ],observations.map(item=>({device:item.code,health:item.health,
      observed:`${item._count.telemetry} samples; ${item._count.heartbeats} heartbeats. Last: ${dateText(item.heartbeats[0]?.recordedAt??null)??'Not recorded'}`,
      measurements:item.telemetry[0]?`UTC ${item.telemetry[0].recordedAt.toISOString()}; temperature ${item.telemetry[0].temperatureC??'N/A'} C; CPU ${item.telemetry[0].cpuPercent??'N/A'}%; packet loss ${item.telemetry[0].packetLossPct??'N/A'}%`:'No telemetry recorded in this period'})),
      'Registry health is current at report generation, not reconstructed historical health. Latest measurements and observation counts are restricted to the selected period; absent recordings can mean the simulation was offline.');
  }

  if (filter.type==='incidents' || filter.type==='executive') {
    if(await db.repairRecord.count({where:{incident:{id:filter.incidentId,deviceId:{in:ids},createdAt:date}}})>reportLimits.rows)
      throw new ReportError('REPORT_TOO_LARGE','Linked incident repair records exceed the report budget. Narrow the filters.',413);
    const rows=boundRows(await reportRows(db,{...filter,type:'incidents',format:'json'},from,to,reportLimits.rows));
    const exactRepairTotals=await db.repairRecord.groupBy({by:['incidentId'],where:{incidentId:{in:rows.map(row=>String(row.incidentId))}},_sum:{cost:true}});
    for(const row of rows)row.repairCostINR=exactRepairTotals.find(total=>total.incidentId===row.incidentId)?._sum.cost?.toFixed(2)??'0.00';
    summary('Incidents created in period',rows.length);
    add('Incident history',[
      ['incidentId','Incident',1.5],['device','Equipment',1],['status','Current status',1],['createdAtUTC','Detected UTC',1.3],['details','Cause / severity / repair',2.2],
    ],rows.map(row=>({...row,details:`${row.severity}; ${row.priority}; cause: ${row.rootCause??'Unconfirmed'}; component: ${row.component??'Unknown'}; repair spend INR ${new Prisma.Decimal(row.repairCostINR??0).toFixed(2)}; duration ${row.repairDurationMs??'Not recorded'} ms`})),
      'Cohort: incidents created in the selected period. Repair total includes the repair records attached to those incidents, including later recorded outcomes.');
    if (filter.incidentId) {
      const incident=await db.incident.findUniqueOrThrow({where:{id:filter.incidentId},include:{events:{take,orderBy:{createdAt:'asc'},include:{actor:{select:{name:true}}}},repairs:{take,orderBy:{createdAt:'asc'},include:{actor:{select:{name:true}}}}}});
      add('Incident details',[['field','Field',1],['value','Recorded value',4]], [
        {field:'Description',value:incident.description},{field:'Acknowledged UTC',value:dateText(incident.acknowledgedAt)},
        {field:'Repair started UTC',value:dateText(incident.repairStartedAt)},{field:'Repair completed UTC',value:dateText(incident.repairCompletedAt)},
        {field:'Resolved UTC',value:dateText(incident.resolvedAt)},
      ]);
      add('Incident workflow audit',[['at','UTC',1.4],['actor','Actor',1],['kind','Action',1],['detail','Recorded detail',2.5]],boundRows(incident.events).map(event=>({at:event.createdAt.toISOString(),actor:event.actor?.name??'System',kind:event.kind,detail:event.detail})),
        'Full selected-incident workflow history, including events outside the incident creation period.');
      add('Incident repairs',[['at','UTC',1.4],['actor','Engineer',1],['action','Recorded repair',2.4],['cost','Cost INR',.9]],boundRows(incident.repairs).map(repair=>({at:repair.createdAt.toISOString(),actor:repair.actor.name,action:repair.action+'; parts: '+repair.spareParts.join('; '),cost:repair.cost.toFixed(2)})));
    }
  }

  let diagnoses: Awaited<ReturnType<typeof diagnosisRows>>|undefined;
  if (['diagnostics','reliability','recommendations','failover','executive'].includes(filter.type)) {
    diagnoses=await diagnosisRows(db,ids,from,to);
  }
  if (filter.type==='diagnostics') {
    summary('Diagnostic findings overlapping period',diagnoses!.length);
    add('Diagnostic findings and recovery guidance',[
      ['device','Equipment',1],['detected','Detected UTC',1.3],['finding','Finding / evidence',2.2],['guidance','Investigation / recovery',2.2],
    ],diagnoses!.map(item=>({device:devices.find(device=>device.id===item.deviceId)!.code,detected:item.detectedAt.toISOString(),
      finding:`${item.ruleCode}; ${item.severity}; component: ${item.component}. Confirmed cause: ${item.confirmedRootCause??'Unconfirmed'}. Suspected: ${item.suspectedCause}. Symptoms: ${list(item.symptoms)}`,
      guidance:`Impact: ${item.serviceImpact}. Investigate: ${list(item.investigationSteps)}. Recovery: ${item.recoveryAction}. Resolved: ${dateText(item.resolvedAt)??'Not recorded'}`})),
      'Findings detected before period end and unresolved at/after period start. Suspected and confirmed causes remain distinct.');
  }

  let workOrders: Awaited<ReturnType<typeof workOrderRows>>|undefined;
  if (['preventive','completion','expenditure','recommendations','executive'].includes(filter.type)) {
    workOrders=await workOrderRows(db,filter,ids,from,to);
  }
  if (['preventive','completion','expenditure','executive'].includes(filter.type)) {
    if (filter.type==='preventive') {
      const plans=filter.workOrderId||filter.incidentId?[]:boundRows(await db.maintenancePlan.findMany({where:{deviceId:{in:ids},nextScheduledAt:date},take,orderBy:{nextScheduledAt:'asc'}}));
      add('Maintenance plans due in period',[['name','Plan',1.6],['device','Equipment',1],['schedule','Schedule / recurrence',2.5],['active','Active',.7]],plans.map(plan=>({name:plan.name,device:devices.find(device=>device.id===plan.deviceId)!.code,
        schedule:plan.nextScheduledAt.toISOString()+'; '+plan.frequency+(plan.customIntervalDays?' / '+plan.customIntervalDays+' days':''),active:plan.active?'Yes':'No'})),
        'Next due occurrences only. Monthly/quarterly/yearly recurrences use fixed day intervals, not civil-calendar dates.');
    }
    const orders=workOrders!;
    summary(filter.type==='completion'?'Completed work orders in period':'Matched work-order cohort',orders.length);
    const expenditure=orders.reduce((total,order)=>total.plus(costs(order).total),new Prisma.Decimal(0));
    summary('Recorded work-order expenditure INR',expenditure.toFixed(2));
    add(filter.type==='completion'?'Completed work orders':'Work-order records',[
      ['id','Order / equipment',1.7],['status','Type / status',1],['dates','Schedule / completion UTC',1.7],['evidence','Findings / verification',2.6],
    ],orders.map(order=>({id:order.id+'\n'+order.device.code+'\n'+order.title,status:order.type+' / '+order.status,
      dates:'Scheduled: '+(dateText(order.scheduledStartAt)??'Not scheduled')+'; started: '+(dateText(order.actualStartAt)??'Not recorded')+'; completed: '+(dateText(order.completedAt)??'Not recorded'),
      evidence:filter.type==='executive'?`Findings recorded: ${order.findings?'Yes':'No'}; verification recorded: ${order.verificationResult?'Yes':'No'}; completed checklist tasks ${order.checklistItems.filter(task=>task.completed).length}/${order.checklistItems.length}. See the completion report for full evidence.`:
        (order.findings??'No findings recorded')+'\nVerification: '+(order.verificationResult??'No verification recorded')})),
      filter.type==='completion'?'CompletedAt is within the selected period; selected work-order details below are its full recorded history.':'Cohort: work orders created, scheduled or completed in the period. Explicit selections must also match the period. Current recorded status is shown.');
    if (filter.type==='expenditure' || filter.type==='executive' || filter.type==='completion') {
      add('Authoritative work-order cost breakdown',[
        ['order','Order / equipment',2.2],['parts','Parts INR',1],['labor','Labor INR',1],['other','Other INR',1],['total','Total INR',1.2],
      ],orders.map(order=>({order:order.device.code+'\n'+order.id,...costs(order)})),
        'Exact Decimal totals: sum(quantity x unit cost) + labor + other. Recorded work-order expenses are not a payment ledger. Incident repair costs are not added: linked records can overlap.');
    }
    if (filter.workOrderId && orders[0]) {
      const order=orders[0];
      const tasks=boundRows(await db.workOrderChecklistItem.findMany({where:{workOrderId:order.id},take,orderBy:{id:'asc'},include:{completedBy:{select:{name:true}}}}));
      const history=boundRows(await db.workOrderStatusHistory.findMany({where:{workOrderId:order.id},take,orderBy:{createdAt:'asc'},include:{actor:{select:{name:true}}}}));
      add('Historical checklist snapshot',[['description','Checklist task',2.2],['result','Result',1],['evidence','Recorded evidence',2.6]],tasks.map(task=>({description:task.description,
        result:task.completed?(task.result??'Result not recorded'):'Incomplete',evidence:(task.remarks??'No remarks')+'; '+(task.completedBy?.name??'No engineer')+'; '+(dateText(task.completedAt)??'No completion time')})));
      add('Spare-part usage',[['part','Part / number',2.5],['quantity','Qty',.6],['unit','Unit INR',1],['total','Total INR',1.1]],order.parts.map(part=>({part:part.partName+(part.partNumber?' / '+part.partNumber:''),quantity:part.quantity,unit:part.unitCost.toFixed(2),total:part.unitCost.mul(part.quantity).toFixed(2)})));
      add('Work-order status and authorization history',[['at','UTC',1.3],['actor','Actor',1],['transition','Transition',1.4],['note','Recorded note',2.2]],history.map(event=>({at:event.createdAt.toISOString(),actor:event.actor.name,transition:(event.fromStatus??'Created')+' -> '+event.toStatus,note:event.note})),
        'Approval and eligibility changes follow the recorded guarded workflow. Report generation never activates equipment.');
    }
  }

  if (['reliability','failover','executive'].includes(filter.type)) {
    const input=await reliabilityInput(db,devices,diagnoses!,from,to);
    const reliability=calculateReliability(input,from,new Date(to.getTime()-1),'RECORDED');
    let serviceReliability=reliability;
    if(filter.device){
      // A device filter narrows equipment metrics, while its logical service still includes the paired device.
      const members=boundRows(await db.device.findMany({where:{system:{code:{in:devices.map(device=>device.system.code)}}},take,select:{id:true,code:true,system:{select:{code:true}}}}));
      const memberDiagnoses=await diagnosisRows(db,members.map(member=>member.id),from,to);
      serviceReliability=calculateReliability(await reliabilityInput(db,members,memberDiagnoses,from,to),from,new Date(to.getTime()-1),'RECORDED');
    }
    summary('Observed service availability',pct(serviceReliability.summary.serviceAvailabilityPct));
    summary('Failure episodes',reliability.summary.failureEpisodes);
    summary('Mean repair time',duration(reliability.summary.mttrMs));
    summary('MTBF',duration(reliability.summary.mtbfMs));
    summary('MTTD',duration(reliability.summary.mttdMs));
    summary('MTTA',duration(reliability.summary.mttaMs));
    add('Recorded service availability',[['code','System',1.4],['observed','Observed hours',1],['downtime','Outage hours',1],['availability','Availability',1],['outageCount','Outages',.8]],serviceReliability.systems.map(row=>({...row,observed:(row.observedMs/3600000).toFixed(3),downtime:(row.downtimeMs/3600000).toFixed(3),availability:pct(row.availabilityPct)})),
      'Uses recorded observation intervals and outage records for all paired members of the matched logical services. Equipment metrics retain the device filter. Unobserved gaps do not inflate observation time; unknown availability is not reported as 100%.');
    if (filter.type==='reliability') {
      add('Equipment reliability',[['code','Equipment',1.2],['failureEpisodes','Failures',.7],['observed','Observed h',1],['downtime','Downtime h',1],['availability','Availability',1.2]],
        reliability.devices.map(row=>({...row,observed:(row.observedMs/3600000).toFixed(3),downtime:(row.downtimeMs/3600000).toFixed(3),availability:pct(row.availabilityPct)})),
        `Metric samples: MTTR ${reliability.coverage.mttrSamples}; MTBF intervals ${reliability.coverage.mtbfIntervals}; MTTD ${reliability.coverage.mttdSamples}; MTTA ${reliability.coverage.mttaSamples}. Planned equipment unavailability ${(reliability.summary.plannedEquipmentUnavailabilityMs/3600000).toFixed(3)} h is reported separately.`);
    }
    if (filter.type!=='reliability') {
      const rows=boundRows(await reportRows(db,{...filter,type:'failovers',format:'json'},from,to,reportLimits.rows));
      add('Failover and controlled switching events',[['detectedAtUTC','UTC',1.3],['system','System',.8],['action','Action / result',1.6],['devices','From / to',1.5],['reason','Reason / duration',2]],
        rows.map(row=>({...row,action:String(row.action).toLowerCase().replaceAll('_',' ')+' / '+String(row.result).toLowerCase().replaceAll('_',' '),devices:(row.fromDevice??'None')+' -> '+(row.toDevice??'None'),reason:row.reason+'; '+row.durationMs+' ms'})),
        'Includes automatic failover, manual failback and planned maintenance switching. Planned switching is not counted as an automatic failure.');
    }
  }

  if (filter.type==='recommendations') {
    const end=new Date(Math.min(to.getTime()-1,at.getTime()));
    const policy={...recommendationPolicy(),windowDays:Math.max(1,Math.ceil((end.getTime()-from.getTime())/86400000))};
    const repairs=boundRows(await db.repairRecord.findMany({where:{createdAt:date,incident:{deviceId:{in:ids}}},take,include:{incident:{select:{deviceId:true}}}}));
    const recommendations=calculateRecommendations({
      devices:devices.map(item=>({id:item.id,code:item.code,name:item.name,systemCode:item.system.code,commissionedAt:item.commissionedAt,
        latestReplacementAt:item.replacements[0]?.replacedAt??null,latestReplacementCost:item.replacements[0]?Number(item.replacements[0].cost):null})),
      faults:diagnoses!.filter(item=>item.detectedAt>=from).map(item=>({id:item.id,deviceId:item.deviceId,rootCause:item.confirmedRootCause,component:item.component,ruleCode:item.ruleCode,detectedAt:item.detectedAt,resolvedAt:item.resolvedAt&&item.resolvedAt<=end?item.resolvedAt:null})),
      repairs:repairs.map(item=>({id:item.id,deviceId:item.incident.deviceId,at:item.createdAt,cost:Number(item.cost)})),
      maintenance:workOrders!.map(item=>({id:item.id,deviceId:item.deviceId,incidentId:item.incidentId,type:item.type,status:item.status,updatedAt:item.updatedAt,
        actualStartAt:item.actualStartAt,completedAt:item.completedAt,verified:!!item.maintenanceModeAt&&!!item.verificationResult&&item.checklistItems.every(task=>task.completed&&!!task.result&&task.result!=='FAILED'),
        findings:item.findings,verificationResult:item.verificationResult,laborCost:item.laborCost.toFixed(2),otherCost:item.otherCost.toFixed(2),parts:item.parts.map(part=>({partName:part.partName,quantity:part.quantity,unitCost:part.unitCost.toFixed(2)}))})),
    },end,policy);
    const decisions=boundRows(await db.recommendationDecision.findMany({where:{deviceId:{in:ids},evidenceHash:{in:recommendations.map(row=>row.evidenceHash)}},take,include:{decidedBy:{select:{name:true}}}}));
    summary('Confirmed cause groups',recommendations.length);
    const actionLabels={CONTINUE_MONITORING:'Continue monitoring',PREVENTIVE_MAINTENANCE:'Preventive maintenance',DETAILED_INVESTIGATION:'Detailed investigation',COMPONENT_REPLACEMENT:'Component replacement review',EQUIPMENT_REPLACEMENT_REVIEW:'Equipment replacement review'};
    add('Explainable replacement decision support',[['device','Equipment / cause',1.4],['actionLabel','Recommended action',1.4],['evidence','Observed evidence',2.8],['review','Supervisor review',1.2]],recommendations.map(row=>{
      const decision=decisions.find(item=>item.deviceId===row.deviceId&&item.causeKey===row.causeKey&&item.evidenceHash===row.evidenceHash);
      return {device:row.deviceCode+'\n'+row.rootCause,action:row.action,actionLabel:actionLabels[row.action],evidence:row.rationale+` Verified corrective completions ${row.maintenance.correctiveCompletions}; subsequent faults ${row.maintenance.failuresAfterCorrective}; work-order spend INR ${row.maintenance.expenditure}; unplanned downtime ${duration(row.downtimeMs)}; age ${row.equipmentAgeDays??'Unknown'} days.`,
        review:decision?decision.decision+' / '+decision.decidedBy.name+' / '+decision.decidedAt.toISOString():'No decision for this evidence'};
    }), 'Uses existing deterministic policy thresholds and the selected observation period. This is not machine learning, a prediction or an automatic replacement order. Preventive work and high expenditure alone do not count as failures. Review status is current for this exact evidence hash.');
  }
  if (filter.type==='executive') summary('Platform audit events (all systems)',await db.auditEvent.count({where:{occurredAt:date}}));
  return validateDocumentSize(report);
}

async function diagnosisRows(db:ReadDb, ids:string[],from:Date,to:Date) {
  return boundRows(await db.faultDiagnosis.findMany({where:{deviceId:{in:ids},detectedAt:{lt:to},OR:[{resolvedAt:null},{resolvedAt:{gte:from}}]},take,orderBy:[{detectedAt:'desc'},{id:'asc'}]}));
}
async function workOrderRows(db:ReadDb, filter:DocumentFilter, ids:string[],from:Date,to:Date) {
  const date={gte:from,lt:to};
  const rows=boundRows(await db.maintenanceWorkOrder.findMany({where:{id:filter.workOrderId,deviceId:{in:ids},incidentId:filter.incidentId,
    type:filter.type==='preventive'?'PREVENTIVE':undefined,status:filter.type==='completion'?'COMPLETED':undefined,
    ...(filter.type==='completion'?{completedAt:date}:{OR:[{createdAt:date},{scheduledStartAt:date},{completedAt:date},...(filter.type==='recommendations'?[{updatedAt:date},{actualStartAt:{lt:to},completedAt:null}]:[])]}),
  },take,orderBy:[{createdAt:'desc'},{id:'asc'}],include:{device:{select:{code:true}}}}));
  if(filter.workOrderId&&!rows.length)throw new ReportError('NOT_FOUND','Selected work order does not match this report type, status or date range',404);
  const orderIds=rows.map(order=>order.id);
  const parts=boundRows(await db.workOrderPartUsage.findMany({where:{workOrderId:{in:orderIds}},take,orderBy:{id:'asc'}}));
  const tasks=boundRows(await db.workOrderChecklistItem.findMany({where:{workOrderId:{in:orderIds}},take,orderBy:{id:'asc'}}));
  return rows.map(order=>({...order,parts:parts.filter(part=>part.workOrderId===order.id),checklistItems:tasks.filter(task=>task.workOrderId===order.id)}));
}

async function reliabilityInput(db:ReadDb,devices:{id:string;code:string;system:{code:string}}[],diagnoses:Awaited<ReturnType<typeof diagnosisRows>>,from:Date,to:Date):Promise<AnalyticsInput>{
  const ids=devices.map(device=>device.id),date={gte:from,lt:to},take=reportLimits.rows+1;
  const counts=ids.length?await db.$queryRaw<{deviceId:string;count:number}[]>`SELECT h."deviceId", COUNT(*)::int AS "count" FROM "Heartbeat" h
    WHERE h."deviceId" IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) AND h."recordedAt">=${from} AND h."recordedAt"<${to}
    AND NOT EXISTS (SELECT 1 FROM "MaintenanceWorkOrder" w WHERE w."deviceId"=h."deviceId" AND w."maintenanceModeAt" IS NOT NULL
      AND w."actualStartAt"<=h."recordedAt" AND (w."completedAt" IS NULL OR w."completedAt">h."recordedAt")) GROUP BY h."deviceId"`:[];
  const outages=boundRows(await db.alarm.findMany({where:{deviceId:{in:ids},sourceKey:{startsWith:'outage:'},createdAt:{lt:to},OR:[{resolvedAt:null},{resolvedAt:{gte:from}}]},take,include:{device:{select:{system:{select:{code:true}}}}}}));
  const incidents=boundRows(await db.incident.findMany({where:{deviceId:{in:ids},OR:[{createdAt:date},{repairCompletedAt:date}]},take}));
  const failovers=boundRows(await db.failoverEvent.findMany({where:{action:'AUTOMATIC_FAILOVER',detectedAt:date,system:{devices:{some:{id:{in:ids}}}}},take,include:{system:{select:{code:true}}}}));
  const maintenance=boundRows(await db.maintenanceWorkOrder.findMany({where:{deviceId:{in:ids},type:{in:['PREVENTIVE','INSPECTION']},maintenanceModeAt:{not:null},actualStartAt:{lt:to},OR:[{completedAt:null},{completedAt:{gte:from}}]},take}));
  return {devices:devices.map(item=>({id:item.id,code:item.code,systemCode:item.system.code,healthyObservedMs:(counts.find(row=>row.deviceId===item.id)?.count??0)*5000})),
    diagnoses:diagnoses.map(item=>({...item,firstObservedAt:item.firstObservedAt??null})),outages:outages.map(item=>({systemCode:item.device.system.code,createdAt:item.createdAt,resolvedAt:item.resolvedAt})),
    incidents:incidents.map(item=>({...item})),failovers:failovers.map(item=>({...item,systemCode:item.system.code})),expenses:[],
    plannedMaintenance:maintenance.map(item=>({deviceId:item.deviceId,start:item.actualStartAt!,end:item.completedAt}))};
}
