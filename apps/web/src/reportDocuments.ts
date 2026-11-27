import { getJson } from './api';
import { getToken } from './auth';

export type DocumentType='health'|'incidents'|'diagnostics'|'reliability'|'preventive'|'completion'|'expenditure'|'recommendations'|'failover'|'executive';
export type DocumentFilters={type:DocumentType;from:string;to:string;device?:string;system?:string;incidentId?:string;workOrderId?:string};
export type DocumentOptions={devices:{id:string;code:string;name:string;system:{code:string;name:string}}[];
  incidents:{id:string;description:string;status:string;device:{code:string}}[];
  workOrders:{id:string;title:string;status:string;incidentId:string|null;device:{code:string}}[];
  truncated:{incidents:boolean;workOrders:boolean}};
const params=(input:Record<string,unknown>)=>new URLSearchParams(Object.entries(input).filter(([,value])=>value!==undefined&&value!=='').map(([key,value])=>[key,String(value)])).toString();
export const getDocumentCatalog=()=>getJson<{data:{type:DocumentType;title:string}[];limits:{days:number;rows:number;pages:number}}>('/api/v1/report-documents/catalog');
export const getDocumentOptions=(filters:DocumentFilters,search:string)=>{
  const {workOrderId:_,...input}=filters;
  return getJson<DocumentOptions>('/api/v1/report-documents/options?'+params({...input,search}),false,25000);
};
export async function generateReportFile(filters:DocumentFilters,format:'pdf'|'csv',signal?:AbortSignal){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000);
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)controller.abort();
  try{
    const response=await fetch('/api/v1/report-documents?'+params({...filters,format}),{headers:{authorization:'Bearer '+(getToken()??'')},signal:controller.signal});
    if(response.status===401)window.dispatchEvent(new Event('aeropulse:unauthorized'));
    if(!response.ok){const body=await response.json().catch(()=>null);throw new Error((body?.error?.code??'HTTP '+response.status)+': '+(body?.error?.message??'Report generation failed'));}
    const expected=format==='pdf'?'application/pdf':'text/csv';
    if(!response.headers.get('content-type')?.includes(expected))throw new Error('Unexpected report content type');
    return {blob:await response.blob(),filename:response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??`aeropulse-${filters.type}.${format}`,
      id:response.headers.get('x-report-id')??'',rows:Number(response.headers.get('x-report-rows')??0),generatedAt:response.headers.get('x-report-generated-at')??''};
  }catch(error){if(controller.signal.aborted)throw new Error(signal?.aborted?'Report request cancelled':'Report request timed out. Narrow the filters and retry.');throw error;}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
}
export function downloadReportUrl(url:string,filename:string){const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();}
