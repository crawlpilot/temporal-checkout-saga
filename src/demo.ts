import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { checkout } from './workflows';
import { orderFor, TASK_QUEUE, type Scenario } from './shared';
import { encodeHistory, summarize, toPlain } from './history';

// One command, three scenarios, real processes:
//   1. the payment gateway fails twice, then the charge succeeds
//   2. the card is declined, and the saga compensates newest first
//   3. the worker is killed mid-shipment, and a second worker finishes the order
// Histories go to ./histories as JSON (to read) and .binpb (to replay). Pass --hold to keep the server and Web UI up afterwards.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workers: ChildProcess[] = [];

function startWorker(env: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(__dirname, 'worker.js')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  workers.push(child);
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`worker exited early (${code})`)));
    // Echo only what the activities did; the SDK's own logs go to stderr too.
    const echo = (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const m = /\[INFO\] (order created|order cancelled|stock reserved|stock released|card charged|refund checked|shipment created|confirmation sent)/.exec(line);
        if (m) console.log(`    [worker ${child.pid}] ${m[1]}`);
      }
    };
    child.stderr!.on('data', echo);
    child.stdout!.on('data', (d: Buffer) => {
      echo(d);
      if (d.toString().includes('WORKER_READY')) resolve(child);
    });
  });
}

async function main() {
  const hold = process.argv.includes('--hold');
  const env = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', port: 7233, ui: true, uiPort: 8233 } });
  const client = env.client;
  mkdirSync('histories', { recursive: true });
  const save = async (id: string) => {
    const history = await client.workflow.getHandle(id).fetchHistory();
    writeFileSync(join('histories', `${id}.json`), JSON.stringify(toPlain(history), null, 1));
    writeFileSync(join('histories', `${id}.binpb`), encodeHistory(history));
    console.log(summarize(history).map((l) => `    ${l}`).join('\n'));
  };
  const start = (scenario: Scenario, id: string) =>
    client.workflow.start(checkout, { taskQueue: TASK_QUEUE, workflowId: id, args: [orderFor(scenario, id)] });
  const outcome = async (handle: Awaited<ReturnType<typeof start>>) => {
    try {
      return `completed: ${await handle.result()}`;
    } catch (err) {
      if (err instanceof WorkflowFailedError) return `failed: ${(err.cause?.cause as Error | undefined)?.message ?? err.cause?.message}`;
      throw err;
    }
  };

  try {
    const stamp = Date.now().toString(36);
    let worker = await startWorker();
    for (const scenario of ['gateway-retry', 'card-declined'] as const) {
      const id = `${scenario}-${stamp}`;
      console.log(`\n▶ ${scenario} (${id})`);
      console.log(`  ${await outcome(await start(scenario, id))}`);
      await save(id);
    }
    worker.kill('SIGKILL');

    const id = `worker-crash-${stamp}`;
    console.log(`\n▶ worker-crash (${id})`);
    worker = await startWorker({ CARRIER_DELAY_MS: '60000' });
    const handle = await start('worker-crash', id);
    // Wait until the shipment has been scheduled, then kill the worker mid-activity.
    for (;;) {
      const h = await handle.fetchHistory();
      if (h.events?.some((e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'createShipment')) break;
      await sleep(100);
    }
    await sleep(500);
    worker.kill('SIGKILL');
    console.log(`    killed worker ${worker.pid} (kill -9) during createShipment; starting a new worker`);
    await startWorker();
    console.log('    (the server retries the shipment once its 10 s start-to-close timeout passes)');
    console.log(`  ${await outcome(handle)}`);
    await save(id);

    console.log(`\nHistories saved in ./histories. Web UI: http://localhost:8233/namespaces/default/workflows`);
    if (hold) {
      console.log('Holding the server open (--hold). Ctrl+C to stop.');
      await new Promise((r) => process.on('SIGINT', r));
    }
  } finally {
    for (const w of workers) w.kill('SIGKILL');
    await env.teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
