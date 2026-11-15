#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
const endpoint = process.argv[process.argv.indexOf('--listen') + 1];
const calls = process.env.FAKE_CODEX_CALLS;
const record = value => fs.appendFileSync(calls, JSON.stringify({ pid: process.pid, ...value }) + '\n');
record({ method: 'spawn', argv: process.argv.slice(2), marker: process.env.KANBAN_RUN });
const loaded = new Map(), saved = new Set(), active = new Map(), terminals = new Map(), peers = new Set(), hanging = new Set();
let threads = 0, turns = 0;
function frame(socket, value) {
 if (socket.destroyed) return;
 const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10);head[0] = 0x81;
 if(body.length < 126) head[1]=body.length; else if(body.length<65536){head[1]=126;head.writeUInt16BE(body.length,2);}else{head[1]=127;head.writeBigUInt64BE(BigInt(body.length),2);}socket.write(Buffer.concat([head,body]));
}
const notify = (method, params, owner) => {
 for(const peer of peers) if(peer === owner || peer.threads.has(params.threadId ?? params.thread?.id)) frame(peer.socket,{method,params});
};
function unload(id, owner) {
 if([...peers].some(p=>p.threads.has(id)) || active.has(id))return;
 setTimeout(()=>{ if([...peers].some(p=>p.threads.has(id))||active.has(id))return;loaded.delete(id);for(const peer of peers)frame(peer.socket,{method:'thread/closed',params:{threadId:id}});},25);
}
const server = http.createServer((req,res)=>res.end('ready'));
server.on('upgrade',(req,socket)=>{
 const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 const peer={socket,threads:new Set()};peers.add(peer);let buffer=Buffer.alloc(0);
 const send = value => frame(socket,value);
 const request=async m=>{
  const p=m.params??{};record({method:m.method,params:p});let result={};
  if(!m.method){record({method:'approval-answer',id:m.id,result:m.result,error:m.error});return;}
  if(m.method==='thread/fork' && p.pausePreparation) await new Promise(resolve=>setTimeout(resolve,1000));
  if(m.method==='initialize') {await new Promise(r=>setTimeout(r,20));result={userAgent:'fake-native'};}
  if(m.method==='config/read') result={config:{mcp_servers:{defaultProbe:{command:'node',env:{STATIC:'kept'}}}}};
  if(m.method==='thread/start'){const id='thread-'+(++threads);loaded.set(id,{model:p.config?.model,config:p.config});saved.add(id);peer.threads.add(id);result={thread:{id,modelProvider:'openai'},model:loaded.get(id).model};}
  if(m.method==='thread/resume'){
   if(p.threadId==='missing'){send({id:m.id,error:{code:-32600,message:'no rollout found for thread id missing'}});return;}
   if(!loaded.has(p.threadId))loaded.set(p.threadId,{model:p.config?.model,config:p.config});saved.add(p.threadId);peer.threads.add(p.threadId);result={thread:{id:p.threadId,status:{type:active.has(p.threadId)?'active':'idle'},modelProvider:'openai'},model:loaded.get(p.threadId).model};
  }
  if(m.method==='thread/fork'){const id='fork-'+(++threads);loaded.set(id,{model:p.config?.model,config:p.config});saved.add(id);peer.threads.add(id);result={thread:{id,forkedFromId:p.threadId},model:p.config?.model};notify('thread/started',result,peer);}
  if(m.method==='thread/loaded/list') result={data:[...loaded.keys()]};
  if(m.method==='thread/read')result={thread:{id:p.threadId,status:{type:active.has(p.threadId)?'active':loaded.has(p.threadId)?'idle':'notLoaded'}}};
  if(m.method.startsWith('thread/backgroundTerminals/')&&!loaded.has(p.threadId)){send({id:m.id,error:{code:-32600,message:'thread not found: '+p.threadId}});return;}
  if(m.method==='thread/backgroundTerminals/list')result={data:terminals.get(p.threadId)??[],nextCursor:null};
  if(m.method==='thread/backgroundTerminals/clean')terminals.delete(p.threadId);
  if(m.method==='turn/start'){
   const text=p.input?.[0]?.text;
   if(text==='crash'){process.exit(1);return;}
   result={turn:{id:'turn-'+(++turns)}};active.set(p.threadId,result.turn.id);notify('turn/started',{threadId:p.threadId,turn:result.turn});
   if(text==='approval')send({id:'permission',method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId:result.turn.id,itemId:'command'}});
   if(text==='retain')terminals.set(p.threadId,[{itemId:'service',processId:'42',command:'service'}]);
   if(text==='hang-release')hanging.add(p.threadId);
   if(text==='finish-service'){terminals.delete(p.threadId);notify('item/completed',{threadId:p.threadId,item:{type:'commandExecution',id:'service',status:'completed'}});}
   if(['retain','finish','finish-service','hang-release'].includes(text)){active.delete(p.threadId);notify('turn/completed',{threadId:p.threadId,turn:{id:result.turn.id,status:'completed',items:[]}});}
  }
  if(m.method==='turn/interrupt'){active.delete(p.threadId);notify('turn/completed',{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted',items:[]}});}
  if(m.method==='thread/unsubscribe'){
   if(hanging.delete(p.threadId))return;
   peer.threads.delete(p.threadId);result={status:loaded.has(p.threadId)?'unsubscribed':'notLoaded'};unload(p.threadId,peer);
  }
  if(m.id!==undefined)send({id:m.id,result});
 };
 socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){if(buffer.length<2)return;const op=buffer[0]&15;let size=buffer[1]&127,offset=2;if(size===126){if(buffer.length<4)return;size=buffer.readUInt16BE(2);offset=4;}else if(size===127){if(buffer.length<10)return;size=Number(buffer.readBigUInt64BE(2));offset=10;}const masked=!!(buffer[1]&128);if(buffer.length<offset+(masked?4:0)+size)return;const mask=masked?buffer.subarray(offset,offset+4):null;offset+=masked?4:0;const body=Buffer.from(buffer.subarray(offset,offset+size));buffer=buffer.subarray(offset+size);if(mask)for(let i=0;i<body.length;i++)body[i]^=mask[i%4];if(op===8){socket.end(Buffer.from([0x88,0]));return;}if(op===1)void request(JSON.parse(body)).catch(e=>{console.error(e);socket.destroy();});}});
 socket.on('error',()=>{});socket.on('close',()=>{peers.delete(peer);for(const id of peer.threads)unload(id);});
});
const listen=endpoint.startsWith('unix://')?endpoint.slice(7):Number(new URL(endpoint).port);
server.listen(listen,endpoint.startsWith('unix://')?undefined:'127.0.0.1');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const peer of peers)peer.socket.destroy();server.close(()=>process.exit());});
