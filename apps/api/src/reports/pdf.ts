import PDFDocument from 'pdfkit';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { reportLimits, ReportError, type ReportDocument, type ReportSection } from './document-model.js';

const fontDirectory = new URL('../../assets/fonts/',import.meta.url);
let fonts:Promise<[Buffer,Buffer,Buffer,Buffer]>|undefined;
const text=(value:unknown)=>value==null||value===''?'Not recorded':String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');

/** Render a bounded immutable report snapshot; no browser, HTML or external URL is evaluated. */
export async function renderReportPdf(report:ReportDocument):Promise<Buffer>{
  fonts??=Promise.all(['Report-Regular.ttf','Report-Bold.ttf','Report-Devanagari-Regular.ttf','Report-Devanagari-Bold.ttf'].map(name=>readFile(new URL(name,fontDirectory)))) as Promise<[Buffer,Buffer,Buffer,Buffer]>;
  const [regular,bold,hindi,hindiBold]=await fonts;
  const doc=new PDFDocument({autoFirstPage:false,size:'A4',bufferPages:true,compress:true,
    margins:{top:82,bottom:58,left:42,right:42},info:{Title:report.title,Author:report.generatedBy.name,
      Subject:'Independent simulated infrastructure report | '+report.id,Creator:'AeroPulse',CreationDate:new Date(report.generatedAt)}});
  doc.registerFont('Report',regular);doc.registerFont('ReportBold',bold);
  doc.registerFont('ReportHindi',hindi);doc.registerFont('ReportHindiBold',hindiBold);
  const chunks:Buffer[]=[];let bytes=0,page=0;
  const output=new Promise<Buffer>((resolve,reject)=>{
    doc.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>reportLimits.bytes)doc.destroy(new ReportError('REPORT_TOO_LARGE','Generated PDF exceeds 8 MiB. Narrow the report.',413));else chunks.push(chunk);});
    doc.once('error',reject);doc.once('end',()=>resolve(Buffer.concat(chunks)));
  });
  // Attach immediately so a rendering failure cannot create an unhandled rejected stream promise.
  void output.catch(()=>{});
  const left=42,width=doc.page?.width?doc.page.width-84:511.28,bodyTop=82,bottom=780;
  let y=bodyTop,operations=0;
  const deadline=performance.now()+12000;
  const check=()=>{if(performance.now()>deadline)throw new ReportError('REPORT_TIMEOUT','PDF generation exceeded its time budget. Narrow the filters.',503);};
  const font=(bold=false,size=9)=>{doc.font(bold?'ReportBold':'Report').fontSize(size).fillColor('#263945');};
  const runs=(value:string,bold:boolean)=>value.split(/([\u0900-\u097f\u200c\u200d]+)/).filter(Boolean).map(part=>({part,font:/[\u0900-\u097f]/.test(part)?(bold?'ReportHindiBold':'ReportHindi'):(bold?'ReportBold':'Report')}));
  // Font shaping is expensive, especially for repeated long checklist/findings text.
  // Keep measurements local to this render and bounded independently of report length.
  const measurements=new Map<string,number>();
  const measureRun=(value:string,name:string,size:number)=>{
    const key=name+'\0'+size+'\0'+value,cached=measurements.get(key);
    if(cached!==undefined)return cached;
    const measured=doc.font(name).fontSize(size).widthOfString(value);
    if(measurements.size<10000)measurements.set(key,measured);
    return measured;
  };
  const measure=(value:string,size:number,bold:boolean)=>runs(value,bold).reduce((sum,run)=>sum+measureRun(run.part,run.font,size),0);
  const line=(value:string,x:number,top:number,w:number,bold=false,size=9,color='#263945')=>{
    let offset=0;
    for(const run of runs(value,bold)){
      doc.font(run.font).fontSize(size).fillColor(color).text(run.part,x+offset,top,{width:w-offset,lineBreak:false});
      offset+=measureRun(run.part,run.font,size);
    }
  };
  doc.on('pageAdded',()=>{
    if(++page>reportLimits.pages)throw new ReportError('REPORT_TOO_LARGE','Report exceeds 80 pages. Narrow the filters.',413);
    line('AEROPULSE',left,28,200,true,12,'#126b78');
    line(report.id,left,46,width,false,7,'#546975');
    line('INDEPENDENT SIMULATION',left+250,32,width-250,false,8,'#546975');
    doc.moveTo(left,57).lineTo(left+width,57).lineWidth(.8).strokeColor('#a8c8cc').stroke();
    y=bodyTop;
  });
  const newPage=()=>{doc.addPage();y=bodyTop;};
  const ensure=(height:number)=>{check();if(y+height>bottom)newPage();};
  const wrap=(value:string,w:number,size=9,bold=false)=>{
    font(bold,size);
    const result:string[]=[];
    for(const paragraph of value.split(/\r?\n/)){
      let current='';
      for(const token of paragraph.split(/\s+/)){
        check();
        if(!token)continue;
        const candidate=current?current+' '+token:token;
        if(measure(candidate,size,bold)<=w){current=candidate;continue;}
        if(current){result.push(current);current='';}
        if(measure(token,size,bold)<=w){current=token;continue;}
        for(const {segment:char} of new Intl.Segmenter('en',{granularity:'grapheme'}).segment(token)){
          check();
          if(current&&measure(current+char,size,bold)>w){result.push(current);current='';}
          current+=char;
        }
      }
      result.push(current);
    }
    return result.length?result:[''];
  };
  const paragraph=(value:string,size=9,bold=false,color='#263945')=>{
    for(const row of wrap(value,width,size,bold)){ensure(size+7);line(row,left,y,width,bold,size,color);y+=size+5;}
    y+=6;
  };
  const heading=(value:string)=>{ensure(110);y+=8;paragraph(value,12,true,'#164b5a');};
  async function table(section:ReportSection){
    const weights=section.columns.map(column=>column.weight??1),total=weights.reduce((sum,value)=>sum+value,0),widths=weights.map(weight=>width*weight/total);
    let headerHeight=0;
    const header=()=>{
      const labels=section.columns.map((column,i)=>wrap(column.label,widths[i]!-12,8,true));
      headerHeight=Math.max(...labels.map(rows=>rows.length))*12+14;
      ensure(headerHeight+24);
      doc.rect(left,y,width,headerHeight).fill('#e9f1f3');
      let x=left;
      for(const [index,rows] of labels.entries()){
        for(const [offset,row] of rows.entries())line(row,x+6,y+7+offset*12,widths[index]!-12,true,8,'#164b5a');
        x+=widths[index]!;
      }
      y+=headerHeight;
    };
    header();
    for(const [rowIndex,row] of section.rows.entries()){
      check();
      const cells=section.columns.map((column,index)=>wrap(text(row[column.key]),widths[index]!-12,8.5));
      const count=Math.max(...cells.map(lines=>lines.length));
      let offset=0;
      while(offset<count){
        let available=Math.floor((bottom-y-12)/12);
        if(available<1){newPage();header();available=Math.floor((bottom-y-12)/12);}
        // Keep a normal row together; only a row taller than a full page is continued.
        const fullCapacity=Math.floor((bottom-bodyTop-headerHeight-12)/12);
        if(offset===0&&count>available&&count<=fullCapacity){newPage();header();available=Math.floor((bottom-y-12)/12);}
        const length=Math.min(count-offset,available),height=length*12+12;
        doc.rect(left,y,width,height).fill(rowIndex%2===0?'#f7f9fa':'#ffffff');
        let x=left;
        for(const [index,rows] of cells.entries()){
          for(let lineIndex=0;lineIndex<length;lineIndex++)if(rows[offset+lineIndex]!==undefined)
            line(rows[offset+lineIndex]!,x+6,y+6+lineIndex*12,widths[index]!-12,false,8.5);
          x+=widths[index]!;
        }
        doc.moveTo(left,y+height).lineTo(left+width,y+height).lineWidth(.3).strokeColor('#dce5e8').stroke();
        y+=height;offset+=length;
        if(offset<count){newPage();header();}
      }
      if(++operations%20===0)await setImmediate();
    }
    y+=8;
  }
  try{
    newPage();
    paragraph(report.title,21,true,'#143744');
    paragraph(report.id,8,false,'#546975');
    paragraph('Generated '+report.generatedAt.replace('T',' ').replace('Z','')+' UTC by '+report.generatedBy.name+' ('+report.generatedBy.role.replaceAll('_',' ')+')',8,false,'#546975');
    paragraph('Equipment: '+(report.filters.device??'All matching')+' | System: '+(report.filters.system??'All matching'),8);
    if(report.filters.incidentId)paragraph('Selected incident: '+report.filters.incidentId,8);
    if(report.filters.workOrderId)paragraph('Selected work order: '+report.filters.workOrderId,8);
    heading('Executive summary');
    await table({title:'Summary',columns:[{key:'label',label:'Measure',weight:2},{key:'value',label:'Recorded value',weight:3}],rows:report.summary});
    for(const section of report.sections){
      heading(section.title);
      if(section.rows.length)await table(section);else paragraph('No recorded data matches this section and the selected filters.',9,false,'#546975');
      if(section.note)paragraph(section.note,8,false,'#546975');
      await setImmediate();
    }
    heading('Scope and interpretation');
    for(const note of report.notes)paragraph(note,8,false,'#546975');
    const pages=doc.bufferedPageRange();
    for(let index=pages.start;index<pages.start+pages.count;index++){
      doc.switchToPage(index);
      // Footer text is intentionally outside the content margin; disable that margin only while drawing it.
      const previousBottom=doc.page.margins.bottom;doc.page.margins.bottom=0;
      doc.moveTo(left,795).lineTo(left+width,795).lineWidth(.5).strokeColor('#c2d1d6').stroke();
      line('AeroPulse | simulated equipment data | UTC',left,805,350,false,7,'#546975');
      line(`Page ${index+1} of ${pages.count}`,left+width-90,805,90,false,7,'#546975');
      doc.page.margins.bottom=previousBottom;
    }
    check();doc.end();return await output;
  }catch(error){doc.destroy(error instanceof Error?error:new Error(String(error)));throw error;}
}
