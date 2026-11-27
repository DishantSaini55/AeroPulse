import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, RefreshCw } from 'lucide-react';
import { formatUtcDateTime } from './time';
import { downloadReportUrl, generateReportFile, getDocumentCatalog, getDocumentOptions, type DocumentFilters, type DocumentType } from './reportDocuments';
import './reports.css';

type Artifact={url:string;filename:string;id:string;rows:number;generatedAt:string;filters:DocumentFilters};
const today=()=>new Date().toISOString().slice(0,10);
export function ReportWorkspace(){
  const [filters,setFilters]=useState<DocumentFilters>({type:'health',from:today(),to:today()});
  const [search,setSearch]=useState(''),[debouncedSearch,setDebouncedSearch]=useState('');
  const [artifact,setArtifact]=useState<Artifact|null>(null),[busy,setBusy]=useState<'pdf'|'csv'|null>(null),[error,setError]=useState('');
  const request=useRef<AbortController|null>(null),serial=useRef(0);
  const catalog=useQuery({queryKey:['document-catalog'],queryFn:getDocumentCatalog,staleTime:300000});
  useEffect(()=>{const timer=setTimeout(()=>setDebouncedSearch(search),300);return()=>clearTimeout(timer);},[search]);
  const {workOrderId:_,...optionFilters}=filters;
  const options=useQuery({queryKey:['document-options',optionFilters,debouncedSearch],queryFn:()=>getDocumentOptions(filters,debouncedSearch),enabled:!!filters.from&&!!filters.to,retry:false,placeholderData:previous=>previous});
  useEffect(()=>()=>{request.current?.abort();},[]);
  useEffect(()=>()=>{if(artifact)URL.revokeObjectURL(artifact.url);},[artifact]);
  const supportsOrders=['preventive','completion','expenditure'].includes(filters.type);
  const supportsIncidents=filters.type==='incidents'||supportsOrders;
  const changed=!!artifact&&JSON.stringify(filters)!==JSON.stringify(artifact.filters);
  function update(next:Partial<DocumentFilters>){setFilters(current=>({...current,...next,incidentId:undefined,workOrderId:undefined}));setError('');}
  async function generate(event:React.FormEvent){
    event.preventDefault();request.current?.abort();const controller=new AbortController();request.current=controller;
    const sequence=++serial.current,selected={...filters};setBusy('pdf');setError('');
    try{const result=await generateReportFile(selected,'pdf',controller.signal);if(sequence!==serial.current)return;
      setArtifact({...result,url:URL.createObjectURL(result.blob),filters:selected});
    }catch(cause){if(!controller.signal.aborted&&sequence===serial.current)setError(cause instanceof Error?cause.message:'PDF generation failed');}
    finally{if(sequence===serial.current)setBusy(null);}
  }
  async function csv(){
    if(!artifact||changed)return;const controller=new AbortController();request.current=controller;setBusy('csv');setError('');
    try{const result=await generateReportFile(artifact.filters,'csv',controller.signal);const url=URL.createObjectURL(result.blob);downloadReportUrl(url,result.filename);setTimeout(()=>URL.revokeObjectURL(url),1500);}
    catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'CSV generation failed');}finally{setBusy(null);}
  }
  const devices=options.data?.devices??[],systems=[...new Set(devices.map(device=>device.system.code))];
  return <>
    <div className="page-heading"><span className="eyebrow">GOVERNANCE / REPORTING</span><h1>Infrastructure reports</h1><p>Generate an authoritative A4 report from recorded simulation data. Preview and PDF download share the same generated file.</p></div>
    <div className="notice neutral-notice"><FileText size={17}/><strong>INDEPENDENT SIMULATION</strong><span>Equipment records are simulated. UTC periods up to {catalog.data?.limits.days??90} days, {catalog.data?.limits.rows??1000} total report rows. Missing measurements remain unavailable.</span></div>
    <form className="panel report-document-filters" onSubmit={event=>void generate(event)} aria-label="Professional report filters">
      <label>Report type<select name="report-type" value={filters.type} onChange={event=>update({type:event.target.value as DocumentType})} disabled={!catalog.data||!!busy} required>
        {catalog.data?.data.map(item=><option key={item.type} value={item.type}>{item.title}</option>)}
      </select></label>
      <label>From (UTC)<input name="from" type="date" required value={filters.from} onChange={event=>update({from:event.target.value})} disabled={!!busy}/></label>
      <label>Through (UTC)<input name="to" type="date" required value={filters.to} min={filters.from} onChange={event=>update({to:event.target.value})} disabled={!!busy}/></label>
      <label>Logical system<select name="system" value={filters.system??''} onChange={event=>update({system:event.target.value||undefined,device:undefined})} disabled={!!busy||options.isFetching}>
        <option value="">All systems</option>{systems.map(code=><option key={code} value={code}>{code}</option>)}
      </select></label>
      <label>Equipment<select name="device" value={filters.device??''} onChange={event=>update({device:event.target.value||undefined})} disabled={!!busy||options.isFetching}>
        <option value="">All matching equipment</option>{devices.filter(device=>!filters.system||device.system.code===filters.system).map(device=><option key={device.id} value={device.code}>{device.code} · {device.name}</option>)}
      </select></label>
      {supportsIncidents&&<label>Find record titles / descriptions<input name="record-search" maxLength={100} value={search} onChange={event=>{setSearch(event.target.value);update({});}} placeholder="Narrow the selections below" disabled={!!busy}/></label>}
      {supportsIncidents&&<label>Incident (optional)<select name="incidentId" value={filters.incidentId??''} onChange={event=>setFilters(current=>({...current,incidentId:event.target.value||undefined,workOrderId:undefined}))} disabled={!!busy||options.isFetching}>
        <option value="">All matching incidents</option>{options.data?.incidents.map(item=><option key={item.id} value={item.id}>{item.device.code} · {item.status} · {item.description} · {item.id}</option>)}
      </select></label>}
      {supportsOrders&&<label>Work order (optional)<select name="workOrderId" value={filters.workOrderId??''} onChange={event=>setFilters(current=>({...current,workOrderId:event.target.value||undefined}))} disabled={!!busy||options.isFetching}>
        <option value="">All matching work orders</option>{options.data?.workOrders.map(item=><option key={item.id} value={item.id}>{item.device.code} · {item.status} · {item.title} · {item.id}</option>)}
      </select></label>}
      <div className="report-actions report-document-actions"><button type="submit" disabled={!!busy||!catalog.data||options.isPending||options.isFetching||!!options.error}><RefreshCw size={15} className={busy==='pdf'?'spin':''}/>{busy==='pdf'?'Generating PDF…':'Generate PDF'}</button>
        <button type="button" className="secondary-button" disabled={!!busy||!artifact||changed} onClick={()=>artifact&&downloadReportUrl(artifact.url,artifact.filename)}><Download size={15}/>Download PDF</button>
        <button type="button" className="secondary-button" disabled={!!busy||!artifact||changed} onClick={()=>void csv()}><Download size={15}/>{busy==='csv'?'Exporting CSV…':'Download CSV'}</button></div>
      {(catalog.error||options.error)&&<p className="form-error" role="alert">{catalog.error?.message??options.error?.message}</p>}
      {options.isFetching&&<small className="report-note">Refreshing equipment and record selections…</small>}
      {(options.data?.truncated.incidents||options.data?.truncated.workOrders)&&<p className="report-note">Selections show the latest 100 matches. Narrow the dates, equipment or search to find another record.</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </form>
    {busy==='pdf'&&<div className="state-panel" role="status">Building the report from authorized database records…</div>}
    {artifact&&<section className="panel report-document-preview" aria-label="Generated PDF preview"><div className="panel-head"><div><span className="eyebrow">GENERATED REPORT</span><h2>{artifact.id}</h2></div><span>{artifact.rows} rows · {formatUtcDateTime(artifact.generatedAt)}</span></div>
      {changed&&<p className="report-note" role="status">Filters have changed. Generate again to preview or download the new selection.</p>}
      {artifact.rows===0&&<p className="report-note">No matching recorded rows. The PDF includes the selected period and explicit empty-data sections.</p>}
      <p className="report-note">PDF is a fixed generated snapshot. CSV exports regenerate matching records at download time. <a href={artifact.url} target="_blank" rel="noreferrer">Open PDF preview in a new tab</a></p>
      <iframe key={artifact.url} src={artifact.url} title="AeroPulse generated report PDF" className="report-pdf-frame"/>
    </section>}
  </>;
}
