// Real-time sync load test: N concurrent editors, grouped into documents, each typing a latency
// marker at a steady rate. Every marker carries the sender's clock; whoever receives it computes
// the one-way sync latency (all virtual users share this machine's clock).
//
//   k6 run -e VUS=1000 bench/k6/sync-load.js        (see bench/README.md for the docker command)
import { WebSocket } from 'k6/websockets';
import { Counter, Trend } from 'k6/metrics';
import { createClient } from './dist/protocol.js';

const seed = JSON.parse(open('../.generated/seed.json'));

const VUS = Number(__ENV.VUS || 1000);
const RAMP = __ENV.RAMP || '60s';
const HOLD = __ENV.HOLD || '120s';
const EDIT_MS = Number(__ENV.EDIT_MS || 1000); // mean gap between a user's edits
const WS_BASE = __ENV.WS_BASE || 'ws://nginx:80';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:3000';
const NAME = __ENV.NAME || 'run';

const syncLatency = new Trend('sync_latency_ms', true); // edit typed by A -> visible to B
const openTime = new Trend('ws_open_ms', true); // connect + upgrade
const firstSync = new Trend('initial_sync_ms', true); // open -> first server message
const edits = new Counter('edits_sent');
const received = new Counter('markers_received');
const unexpectedCloses = new Counter('unexpected_closes');
const wsErrors = new Counter('ws_errors');

export const options = {
  scenarios: {
    editors: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: HOLD, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
      gracefulStop: '15s',
    },
  },
  thresholds: {
    sync_latency_ms: ['p(95)<500'], // target; the run reports whether it was met
    unexpected_closes: ['count<10'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const docId = seed.docs[(__VU - 1) % seed.docs.length];
  const url = `${WS_BASE}/ws/docs/${docId}`;
  let ws;
  let closedByUs = false;
  let ready = false;
  let timer = null;
  const t0 = Date.now();

  const client = createClient({
    onSend: (m) => {
      if (ws && ws.readyState === 1) {
        ws.send(m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength));
      }
    },
    onMarker: (ts8) => {
      const now = Date.now() % 100_000_000;
      syncLatency.add((now - ts8 + 100_000_000) % 100_000_000);
      received.add(1);
    },
  });

  ws = new WebSocket(url, null, { headers: { Cookie: seed.cookie, Origin: ORIGIN } });
  ws.binaryType = 'arraybuffer';

  const scheduleEdit = () => {
    timer = setTimeout(
      () => {
        if (ws.readyState !== 1 || closedByUs) return;
        if (ready) {
          client.typeMarker(Date.now());
          edits.add(1);
        }
        scheduleEdit();
      },
      EDIT_MS * (0.5 + Math.random()),
    );
  };

  ws.onopen = () => {
    openTime.add(Date.now() - t0);
    ws.send(client.step1().buffer);
    scheduleEdit();
  };
  ws.onmessage = (e) => {
    if (!ready) {
      ready = true;
      firstSync.add(Date.now() - t0);
    }
    client.handle(new Uint8Array(e.data));
  };
  ws.onerror = () => wsErrors.add(1);
  ws.onclose = () => {
    if (timer) clearTimeout(timer);
    if (!closedByUs) unexpectedCloses.add(1);
    client.destroy();
  };

  // Stay connected for the whole test; k6 interrupts the iteration when the VU is ramped down.
  setTimeout(
    () => {
      closedByUs = true;
      ws.close();
    },
    15 * 60 * 1000,
  );
}

function metric(data, name, stat) {
  const m = data.metrics[name];
  return m && m.values[stat] !== undefined ? m.values[stat] : null;
}

export function handleSummary(data) {
  const fmt = (v) => (v === null ? 'n/a' : v.toFixed(1));
  const lines = [
    `\n=== ${NAME}: ${VUS} editors, ${seed.docs.length} documents, edit every ~${EDIT_MS} ms ===`,
    `sync latency (ms)   p50=${fmt(metric(data, 'sync_latency_ms', 'med'))}  p95=${fmt(metric(data, 'sync_latency_ms', 'p(95)'))}  p99=${fmt(metric(data, 'sync_latency_ms', 'p(99)'))}  max=${fmt(metric(data, 'sync_latency_ms', 'max'))}`,
    `ws open (ms)        p50=${fmt(metric(data, 'ws_open_ms', 'med'))}  p95=${fmt(metric(data, 'ws_open_ms', 'p(95)'))}`,
    `initial sync (ms)   p50=${fmt(metric(data, 'initial_sync_ms', 'med'))}  p95=${fmt(metric(data, 'initial_sync_ms', 'p(95)'))}`,
    `edits sent=${metric(data, 'edits_sent', 'count')}  markers received=${metric(data, 'markers_received', 'count')}  unexpected closes=${metric(data, 'unexpected_closes', 'count')}  ws errors=${metric(data, 'ws_errors', 'count')}`,
    `peak concurrent VUs=${metric(data, 'vus_max', 'max')}`,
    '',
  ];
  return {
    stdout: lines.join('\n'),
    [`/bench/results/k6-${NAME}.json`]: JSON.stringify(data, null, 2),
  };
}
