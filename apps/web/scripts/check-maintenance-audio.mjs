import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import ts from 'typescript';

// Exercise the real TypeScript manager with browser API doubles; no physical audio claim.
const source = await readFile(new URL('../src/alarmAudio.ts', import.meta.url),'utf8');
const { outputText } = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
const { AlarmAudioManager, defaultAudioPreferences, buildVoiceAnnouncement } = await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
const stored = new Map(), spoken = [], contexts = [], channels = [];
globalThis.sessionStorage = {getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)};
globalThis.BroadcastChannel = class {constructor(name){this.name=name;channels.push(this);}addEventListener(_,listener){this.listener=listener;}postMessage(data){for(const other of channels)if(other!==this&&other.name===this.name&&!other.closed)other.listener?.({data});}close(){this.closed=true;}};
const gain = () => ({gain:{value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){return this;},disconnect(){}});
globalThis.AudioContext = class {constructor(){this.state='suspended';this.currentTime=0;contexts.push(this);}async resume(){this.state='running';}async close(){this.state='closed';}createGain(){return gain();}createOscillator(){return {type:'sine',frequency:{value:0},connect(){return gain();},start(){},stop(){}};}};
globalThis.SpeechSynthesisUtterance = class {constructor(text){this.text=text;}};
globalThis.speechSynthesis = {speak:utterance=>spoken.push(utterance),cancel(){},getVoices:()=>[]};
let managers = [];
const create = (prefs={},scope=crypto.randomUUID()) => {const preferences={...defaultAudioPreferences,...prefs};const manager=new AlarmAudioManager(()=>preferences,scope);managers.push(manager);return {manager,preferences};};
const notice = (id='notice',level='INFORMATION') => ({id,level,message:'SYSTEM-X DEVICE-Y: maintenance completion approved and recorded.',resolvedAt:null,acknowledged:false,operationalNotice:true,device:{code:'DEVICE-Y',name:'Device Y',system:{code:'SYSTEM-X',name:'System X'}}});
afterEach(()=>{for(const manager of managers)manager.destroy();managers=[];spoken.length=0;stored.clear();});

test('maintenance speech uses authoritative notice wording without inventing a fault or service outcome',()=>{
  const text=buildVoiceAnnouncement(notice());assert.match(text,/Simulation notice/);assert.match(text,/SYSTEM-X DEVICE-Y/);assert.ok(!text.includes('fault detected'));assert.ok(!text.includes('Service remains available'));
});
test('autoplay waits for explicit activation and duplicate notices do not replay',async()=>{
  const {manager}=create();manager.enqueue(notice());assert.equal(spoken.length,0);await manager.activate();assert.equal(spoken.length,1);
  manager.enqueue(notice());assert.equal(spoken.length,1);
});
test('one voice queue preserves priority and critical alarms preempt routine speech without overlapping completion callbacks',async()=>{
  const {manager}=create({soundEnabled:false});await manager.activate();manager.enqueue(notice('routine'));manager.enqueue(notice('next','WARNING'));
  assert.equal(spoken.length,1);const interrupted=spoken[0];manager.enqueue({...notice('critical','CRITICAL'),operationalNotice:undefined});assert.equal(spoken.length,2);
  interrupted.onend();assert.equal(spoken.length,2);spoken[1].onend();assert.equal(spoken.length,3);assert.match(spoken[2].text,/maintenance completion/);
});
test('mute and disabled severity consume local notices without changing any server acknowledgement state',async()=>{
  const {manager,preferences}=create({muted:true});await manager.activate();const row=notice();manager.enqueue(row);assert.equal(spoken.length,0);assert.equal(row.acknowledged,false);
  preferences.muted=false;manager.enqueue(row);assert.equal(spoken.length,0);
  preferences.severities={...preferences.severities,WARNING:false};manager.enqueue(notice('disabled','WARNING'));assert.equal(spoken.length,0);
});
test('same-user tabs and page reloads deduplicate while different user scopes remain independent',async()=>{
  const a=create({soundEnabled:false},'user-a'),b=create({soundEnabled:false},'user-a'),c=create({soundEnabled:false},'user-b');
  await Promise.all([a.manager.activate(),b.manager.activate(),c.manager.activate()]);a.manager.enqueue(notice());b.manager.enqueue(notice());c.manager.enqueue(notice());assert.equal(spoken.length,2);
  const reload=create({soundEnabled:false},'user-a');await reload.manager.activate();reload.manager.enqueue(notice());assert.equal(spoken.length,2);
});
test('routine maintenance never starts a repeating alarm and cannot replace an active critical repeating tone',async()=>{
  const {manager}=create({voiceEnabled:false});await manager.activate();manager.enqueue(notice());assert.equal(manager.repeat,null);
  manager.enqueue(notice('critical','CRITICAL'));assert.ok(manager.repeat);const timer=manager.repeat;
  manager.enqueue(notice('upcoming'));assert.equal(manager.repeat,timer);
  manager.reconcileActiveAlarms([]);assert.equal(manager.repeat,null);
});
test('unavailable browser speech API still allows visual workflow and audio manager cleanup',async()=>{
  const speech=globalThis.speechSynthesis,utterance=globalThis.SpeechSynthesisUtterance;
  try{delete globalThis.speechSynthesis;delete globalThis.SpeechSynthesisUtterance;const {manager}=create({soundEnabled:false});await manager.activate();assert.equal(manager.voiceSupported,false);manager.enqueue(notice());manager.stopAll();}
  finally{globalThis.speechSynthesis=speech;globalThis.SpeechSynthesisUtterance=utterance;}
});
