import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as real from '../src/activities';
import { checkout } from '../src/workflows';
import { orderFor, type Scenario } from '../src/shared';

// Runs the real workflow on a local dev server with spied activities, then replays each
// recorded history through the current code: if a change makes the workflow issue different
// commands for an old history, the replay throws a nondeterminism error and the test fails.

const workflowsPath = require.resolve('../src/workflows');
let env: TestWorkflowEnvironment;
let calls: string[] = [];

const spied = Object.fromEntries(
  Object.entries(real).map(([name, fn]) => [
    name,
    async (...args: unknown[]) => {
      calls.push(name);
      return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  ]),
) as typeof real;

before(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});
after(async () => {
  await env?.teardown();
});

async function run(scenario: Scenario) {
  calls = [];
  const taskQueue = `test-${scenario}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities: spied });
  const id = `${scenario}-${Date.now()}`;
  return worker.runUntil(async () => {
    const handle = await env.client.workflow.start(checkout, { taskQueue, workflowId: id, args: [orderFor(scenario, id)] });
    let outcome: string;
    try {
      outcome = `ok:${await handle.result()}`;
    } catch (err) {
      assert.ok(err instanceof WorkflowFailedError);
      outcome = `failed:${(err.cause?.cause as Error | undefined)?.message}`;
    }
    return { id, outcome, history: await handle.fetchHistory() };
  });
}

const replays: Awaited<ReturnType<typeof run>>[] = [];

test('happy path runs every step once, in order', async () => {
  const r = await run('happy');
  replays.push(r);
  assert.match(r.outcome, /^ok:shp_/);
  assert.deepEqual(calls, ['createOrder', 'reserveInventory', 'chargePayment', 'createShipment', 'sendConfirmation']);
});

test('a declined card compensates newest first and fails the workflow', async () => {
  const r = await run('card-declined');
  replays.push(r);
  assert.equal(r.outcome, 'failed:card declined: insufficient funds');
  assert.deepEqual(calls, ['createOrder', 'reserveInventory', 'chargePayment', 'refundPayment', 'releaseInventory', 'cancelOrder']);
});

test('gateway 503s are retried with backoff and only the final attempt is recorded', async () => {
  const r = await run('gateway-retry');
  replays.push(r);
  assert.match(r.outcome, /^ok:shp_/);
  assert.equal(calls.filter((c) => c === 'chargePayment').length, 3);
  const started = r.history.events!.filter((e) => e.activityTaskStartedEventAttributes);
  const charge = started.find((e) => e.activityTaskStartedEventAttributes!.attempt === 3);
  assert.ok(charge, 'the charge is recorded as attempt 3');
  assert.equal(charge!.activityTaskStartedEventAttributes!.lastFailure?.message, 'payment gateway returned 503');
});

test('every recorded history replays through the current workflow code', async () => {
  assert.equal(replays.length, 3);
  for (const r of replays) await Worker.runReplayHistory({ workflowsPath }, r.history, r.id);
});

// Histories recorded by `npm run demo` and committed. Unlike the runs above, these were made
// by an earlier build, which is exactly what a new worker meets in production: if you reorder,
// add or remove an activity call without patched(), this test fails with a nondeterminism error.
test('histories recorded by earlier code still replay', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { decodeHistory } = await import('../src/history');
  const dir = join(__dirname, '..', '..', 'test', 'fixtures');
  const files = readdirSync(dir).filter((f) => f.endsWith('.binpb'));
  assert.ok(files.length >= 3);
  for (const f of files) await Worker.runReplayHistory({ workflowsPath }, decodeHistory(readFileSync(join(dir, f))), f);
});
