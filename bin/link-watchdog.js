// Network failure handling shared by the agent and deterministic regression tests.
// Every WebSocket is monitored without opening a terminal or spawning a second agent.
export class ReconnectBackoff {
  constructor({ baseMs = 1000, capMs = 30000, random = Math.random } = {}) {
    this.baseMs = baseMs;
    this.capMs = capMs;
    this.random = random;
    this.attempt = 0;
  }
  nextDelay() {
    const ceiling = Math.min(this.capMs, this.baseMs * (2 ** Math.min(this.attempt++, 20)));
    return Math.max(200, Math.round(ceiling * (0.8 + 0.4 * this.random())));
  }
  reset() { this.attempt = 0; }
}

export function monitorWebSocket(ws, {
  onStale,
  heartbeatMs = 20000,
  staleMs = 55000,
  now = Date.now,
  schedule = setInterval,
  cancel = clearInterval
} = {}) {
  let lastProof = now();
  let closed = false;
  const alive = () => { lastProof = now(); };
  ws.on("pong", alive);
  ws.on("message", alive);
  const interval = schedule(() => {
    if (closed) return;
    if (now() - lastProof > staleMs) {
      closed = true;
      try { onStale?.(); } finally { ws.terminate(); }
      return;
    }
    if (ws.readyState !== 1) return;
    try {
      ws.ping();
      ws.send(JSON.stringify({ type: "heartbeat", ts: now() }));
    } catch {
      ws.terminate();
    }
  }, heartbeatMs);
  return () => {
    closed = true;
    cancel(interval);
    ws.off("pong", alive);
    ws.off("message", alive);
  };
}
