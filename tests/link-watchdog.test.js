import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectBackoff, monitorWebSocket } from '../bin/link-watchdog.js';

test('retry uses bounded exponential backoff and no busy retry', () => {
  const backoff = new ReconnectBackoff({random:()=>0.5});
  assert.deepEqual([0,1,2,3,4,5,6,7].map(()=>backoff.nextDelay()),
    [1000,2000,4000,8000,16000,30000,30000,30000]);
  backoff.reset();
  assert.equal(backoff.nextDelay(),1000);
});
test('retry jitters and never exceeds cap by more than 20 percent', () => {
  const min = new ReconnectBackoff({random:()=>0});
  const max = new ReconnectBackoff({random:()=>1});
  assert.equal(min.nextDelay(),800);
  assert.equal(max.nextDelay(),1200);
  for(let n=0;n<20;n++) { min.nextDelay();max.nextDelay(); }
  assert.equal(min.nextDelay(),24000);
  assert.equal(max.nextDelay(),36000);
});
test('dead connections are terminated and stopped once without opening processes', () => {
  const callbacks = new Map();
  const listeners = new Map();
  let clock = 0, terminated = 0, ticks = 0;
  const ws = {
    readyState:1,
    on:(name,cb)=>listeners.set(name,cb),
    off:(name,cb)=>{if(listeners.get(name)===cb)listeners.delete(name)},
    ping:()=>{},
    send:()=>{},
    terminate:()=>{terminated++}
  };
  const stop = monitorWebSocket(ws, {
    heartbeatMs:10, staleMs:45,
    now:()=>clock,
    schedule:(fn)=>{callbacks.set('tick',fn);return 'tick'},
    cancel:(id)=>callbacks.delete(id),
    onStale:()=>{ticks++}
  });
  callbacks.get('tick')();
  clock = 20; listeners.get('pong')(); callbacks.get('tick')();
  clock = 75; callbacks.get('tick')(); // pong is stale
  assert.equal(terminated,1);
  assert.equal(ticks,1);
  stop();
  assert.equal(callbacks.size,0);
  assert.equal(listeners.size,0);
});
test('regular pong traffic and messages keep a connection alive', () => {
  let clock=0,pings=0,beats=0,closes=0;
  const hooks={};
  const ws={readyState:1,on:(n,f)=>hooks[n]=f,off:(n,f)=>{if(hooks[n]===f)delete hooks[n]},ping:()=>pings++,send:()=>beats++,terminate:()=>closes++};
  let ticker;
  const stop=monitorWebSocket(ws,{staleMs:60,now:()=>clock,schedule:fn=>{ticker=fn;return 1},cancel:()=>{}});
  for(let i=0;i<20;i++){clock+=25;hooks.pong();ticker()}
  assert.equal(closes,0);assert.equal(pings,20);assert.equal(beats,20);
  stop();
});

import WebSocket, { WebSocketServer } from 'ws';
test('real websocket: normal pong, disconnect, automatic reconnect after local server returns', {timeout:12000}, async()=>{
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(resolve=>server.once('listening',resolve));
  const port=server.address().port;
  const address='ws://127.0.0.1:'+port;
  let active=server,connected=0;
  async function start() {
    const ws = new WebSocket(address,{handshakeTimeout:1000});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
    connected++;
    const stop=monitorWebSocket(ws,{heartbeatMs:30,staleMs:180});
    return {ws,stop};
  }
  const first=await start();
  await new Promise(resolve=>setTimeout(resolve,75));
  assert.equal(first.ws.readyState,WebSocket.OPEN);
  first.stop();
  // Simulate the network going away without restarting the agent process.
  for (const peer of active.clients) peer.terminate();
  await new Promise(resolve=>first.ws.once('close',resolve));
  await new Promise((resolve,reject)=>active.close(err=>err?reject(err):resolve()));
  await assert.rejects(start(),/ECONNREFUSED|WebSocket/i);
  active=new WebSocketServer({host:'127.0.0.1',port});
  await new Promise(resolve=>active.once('listening',resolve));
  const restored=await start();
  assert.equal(connected,2);
  assert.equal(restored.ws.readyState,WebSocket.OPEN);
  restored.stop();
  restored.ws.terminate();
  await new Promise(resolve=>active.close(resolve));
});
