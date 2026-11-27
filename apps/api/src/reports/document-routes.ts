import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { PublicUser } from '../auth.js';
import { buildReportDocument } from './document-data.js';
import { documentFilterSchema, reportLimits, reportTitles, reportWindow, ReportError } from './document-model.js';
import { renderReportPdf } from './pdf.js';
import { toCsv } from './csv.js';

export class ReportGate {
  private users=new Set<string>();
  constructor(private readonly limit:number=reportLimits.concurrent){}
  acquire(userId:string){
    if(this.users.has(userId)||this.users.size>=this.limit)throw new ReportError('REPORT_BUSY','A report is already running. Please retry shortly.',429);
    this.users.add(userId);let released=false;
    return ()=>{if(!released){released=true;this.users.delete(userId);}};
  }
}
const sharedGate=new ReportGate();
export function documentRoutes(db:Database,gate=sharedGate){
  const router=Router();
  const manager:RequestHandler=(_request,response,next)=>{
    if(!['SUPERVISOR','ADMINISTRATOR'].includes((response.locals.user as PublicUser).role)){
      response.status(403).json({error:{code:'FORBIDDEN',message:'Supervisor access is required for historical reports'}});return;
    }next();
  };
  router.use('/report-documents',manager);
  router.get('/report-documents/catalog',(_request,response)=>{
    response.setHeader('Cache-Control','no-store');
    response.json({data:Object.entries(reportTitles).map(([type,title])=>({type,title})),limits:reportLimits,simulated:true});
  });
  router.get('/report-documents/options',async(request,response)=>{
    try{
      const input=documentFilterSchema.pick({type:true,from:true,to:true,device:true,system:true,incidentId:true}).extend({search:z.string().trim().max(100).default('')}).parse(request.query);
      const {from,to}=reportWindow({...input,format:'json'}), date={gte:from,lt:to};
      const devices=await db.device.findMany({take:reportLimits.rows+1,orderBy:{code:'asc'},select:{id:true,code:true,name:true,system:{select:{code:true,name:true}}}});
      if(devices.length>reportLimits.rows)throw new ReportError('REPORT_TOO_LARGE','Equipment registry exceeds report selection limit',413);
      const ids=devices.filter(device=>(!input.device||device.code===input.device)&&(!input.system||device.system.code===input.system)).map(device=>device.id);
      const incidents=await db.incident.findMany({where:{deviceId:{in:ids},createdAt:date,description:input.search?{contains:input.search,mode:'insensitive'}:undefined},
        take:101,orderBy:[{createdAt:'desc'},{id:'asc'}],select:{id:true,description:true,status:true,device:{select:{code:true}}}});
      const orders=await db.maintenanceWorkOrder.findMany({where:{deviceId:{in:ids},incidentId:input.incidentId,type:input.type==='preventive'?'PREVENTIVE':undefined,
        status:input.type==='completion'?'COMPLETED':undefined,title:input.search?{contains:input.search,mode:'insensitive'}:undefined,
        ...(input.type==='completion'?{completedAt:date}:{OR:[{createdAt:date},{scheduledStartAt:date},{completedAt:date}]}),},
        take:101,orderBy:[{createdAt:'desc'},{id:'asc'}],select:{id:true,title:true,status:true,incidentId:true,device:{select:{code:true}}}});
      response.setHeader('Cache-Control','no-store');response.json({devices,incidents:incidents.slice(0,100),workOrders:orders.slice(0,100),
        truncated:{incidents:incidents.length>100,workOrders:orders.length>100},simulated:true});
    }catch(error){if(error instanceof z.ZodError){response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Invalid report selection filters'}});return;}throw error;}
  });
  const limiter=rateLimit({windowMs:60000,limit:12,standardHeaders:'draft-8',legacyHeaders:false,keyGenerator:(_request,response)=>(response.locals.user as PublicUser).id,
    message:{error:{code:'REPORT_RATE_LIMIT',message:'At most 12 report generations per minute per user. Please retry shortly.'}}});
  router.get('/report-documents',limiter,async(request,response)=>{
    let release:(()=>void)|undefined;
    try{
      const parsed=documentFilterSchema.safeParse(request.query);
      if(!parsed.success){response.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose a supported report, valid UTC dates and compatible selections'}});return;}
      reportWindow(parsed.data);
      const actor=response.locals.user as PublicUser;
      release=gate.acquire(actor.id);
      const report=await buildReportDocument(db,parsed.data,actor);
      const format=parsed.data.format;
      const output=format==='pdf'?await renderReportPdf(report):format==='csv'?toCsv(['section','record','field','value'],report.sections.flatMap(section=>section.rows.flatMap((row,index)=>section.columns.map(column=>({section:section.title,record:index+1,field:column.label,value:row[column.key]??null}))))):report;
      await db.auditEvent.create({data:{actorId:actor.id,actorRole:actor.role,method:'GET',statusCode:200,
        path:`/api/v1/report-documents/${report.id}?type=${report.type}&from=${parsed.data.from}&to=${parsed.data.to}&format=${format}`}});
      response.setHeader('Cache-Control','no-store');response.setHeader('X-Report-Id',report.id);
      response.setHeader('X-Report-Rows',String(report.rowCount));response.setHeader('X-Report-Generated-At',report.generatedAt);
      if(format==='json'){response.json(report);return;}
      const filename=`aeropulse-${report.type}-${parsed.data.from}-to-${parsed.data.to}-${report.id.slice(-8)}.${format}`;
      response.type(format==='pdf'?'application/pdf':'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition',`attachment; filename="${filename}"`);response.send(output);
    }catch(error){
      if(error instanceof ReportError){if(error.status===429)response.setHeader('Retry-After','5');response.status(error.status).json({error:{code:error.code,message:error.message}});return;}
      throw error;
    }finally{release?.();}
  });
  // Options errors share the same safe, typed responses as generation errors.
  router.use((error:unknown,_request:unknown,response:import('express').Response,next:import('express').NextFunction)=>{
    if(error instanceof ReportError){response.status(error.status).json({error:{code:error.code,message:error.message}});return;}next(error);
  });
  return router;
}
