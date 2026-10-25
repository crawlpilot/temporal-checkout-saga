# Temporal checkout saga

A runnable checkout saga on [Temporal](https://temporal.io) in TypeScript: create the order, reserve stock, charge the card, ship, confirm. If the charge fails for good, the saga undoes the earlier steps newest first. Once the card is charged, the remaining steps are retried forward, never undone.

It's the companion code to **[Temporal Explained: Durable Workflows, When to Use Them, and a Saga You Can Crash](https://crawlpilot.tech/blog/temporal-durable-execution-saga)**. The workflow in [`src/workflows.ts`](src/workflows.ts) is the one in the post, and `npm run demo` reproduces the post's three recorded runs on your machine.

## Run it

You need Node.js 20 or later. You don't need to install Temporal: the first run downloads a local Temporal dev server (via [`@temporalio/testing`](https://www.npmjs.com/package/@temporalio/testing)), so it needs internet access once.

```bash
npm install
npm run demo            # three scenarios, real worker processes, then exits
npm run demo -- --hold  # same, then keeps the server and Web UI up (http://localhost:8233)
```

You'll see this (process ids and workflow ids vary):

```text
▶ gateway-retry (gateway-retry-mvnz8ypt)
    [worker 5159] order created
    [worker 5159] stock reserved
    [worker 5159] card charged
    [worker 5159] shipment created
    [worker 5159] confirmation sent
  completed: shp_gateway-retry-mvnz8ypt

▶ card-declined (card-declined-mvnz8ypt)
    [worker 5159] order created
    [worker 5159] stock reserved
    [worker 5159] refund checked
    [worker 5159] stock released
    [worker 5159] order cancelled
  failed: card declined: insufficient funds

▶ worker-crash (worker-crash-mvnz8ypt)
    [worker 5225] order created
    [worker 5225] stock reserved
    [worker 5225] card charged
    killed worker 5225 (kill -9) during createShipment; starting a new worker
    (the server retries the shipment once its 10 s start-to-close timeout passes)
    [worker 5260] shipment created
    [worker 5260] confirmation sent
  completed: shp_worker-crash-mvnz8ypt
```

After each run the demo prints the recorded event history, and saves it to `histories/` as JSON (to read) and `.binpb` (to replay).

| Scenario | What happens | What to look for in the history |
| --- | --- | --- |
| `gateway-retry` | The payment gateway returns 503 twice, then succeeds | One `ActivityTaskStarted` for the charge, with `attempt 3` and the last failure. Retries don't add events. |
| `card-declined` | The card is declined, a non-retryable error | `refundPayment`, `releaseInventory`, `cancelOrder`, newest first, then `WorkflowExecutionFailed` |
| `worker-crash` | The worker is killed mid-shipment | The second worker's `createShipment` is `attempt 2` with "activity StartToClose timeout". The card isn't charged again. |

## Run the pieces yourself

Use three terminals:

```bash
npm run server                          # Temporal dev server + Web UI (or: temporal server start-dev)
npm run worker                          # a worker; start a second one, kill one, see what happens
npm run checkout -- card-declined       # or gateway-retry, worker-crash, happy; optional 2nd arg: order id
```

To crash it by hand, start a worker with `CARRIER_DELAY_MS=60000 npm run worker`, run `npm run checkout -- worker-crash`, kill that worker during the shipment, then start a normal `npm run worker`. Set `TEMPORAL_ADDRESS` to use a server other than `127.0.0.1:7233`.

## What's where

| File | What it is |
| --- | --- |
| [`src/workflows.ts`](src/workflows.ts) | The saga: register each compensation before its step, undo newest first in a non-cancellable scope, retry forward after the pivot |
| [`src/activities.ts`](src/activities.ts) | Stand-ins for the order, stock, payment and shipping services. The card token and address pick each scenario's behaviour. |
| [`src/worker.ts`](src/worker.ts), [`src/start.ts`](src/start.ts), [`src/server.ts`](src/server.ts) | A worker, a client that starts one checkout, and a local dev server |
| [`src/demo.ts`](src/demo.ts) | The three scenarios end to end, with real worker processes |
| [`test/checkout.test.ts`](test/checkout.test.ts) | Tests, including replay of committed histories |

The saga follows Temporal's [saga guidance](https://docs.temporal.io/design-patterns/saga-pattern):

- Register each compensation before its step, because a step can take effect and still fail (a charge whose reply times out).
- Make every compensation idempotent, because it may run for a step that never happened.
- Let compensations retry until they succeed, and log and continue if one still fails.

## Tests, and why replay matters

```bash
npm test
```

The tests run the workflow against a local dev server and check each scenario's activity calls and outcome. The last test replays the histories in [`test/fixtures/`](test/fixtures), which were recorded from an earlier build, through the current code. That's what a new worker does with a run that started on old code.

Try it: add an activity call before the charge in `src/workflows.ts`, then run `npm test`:

```ts
await reserveInventory(order);
await sendConfirmation(order, 'pending'); // a new step
```

The replay test fails with a nondeterminism error:

```text
[TMPRL1100] Nondeterminism error: Activity type of scheduled event 'chargePayment'
does not match activity type of activity command 'sendConfirmation'
```

Wrap the new step in [`patched()`](https://docs.temporal.io/develop/typescript/workflows/versioning) and it passes again: old runs find no patch marker in their history and skip the new step.

```ts
if (patched('confirm-before-charge')) await sendConfirmation(order, 'pending');
```

To refresh the fixtures after an intended, compatible change, run `npm run demo` and copy `histories/<scenario>-*.binpb` to `test/fixtures/<scenario>.binpb`. Stack traces are blanked when histories are saved, so the fixtures don't carry local paths.

## License

MIT
