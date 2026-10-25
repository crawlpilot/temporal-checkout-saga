import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { checkout } from './workflows';
import { ADDRESS, orderFor, TASK_QUEUE, type Scenario } from './shared';

// Usage: npm run checkout -- <gateway-retry|card-declined|worker-crash|happy> [order-id]
async function main() {
  const scenario = (process.argv[2] ?? 'happy') as Scenario;
  const id = process.argv[3] ?? `order-${Date.now()}`;
  const client = new Client({ connection: await Connection.connect({ address: ADDRESS }) });
  const handle = await client.workflow.start(checkout, { taskQueue: TASK_QUEUE, workflowId: id, args: [orderFor(scenario, id)] });
  console.log(`started ${id} (${scenario}); open http://localhost:8233/namespaces/default/workflows/${id}`);
  try {
    console.log('result:', await handle.result());
  } catch (err) {
    if (err instanceof WorkflowFailedError) console.log('failed:', (err.cause?.cause as Error | undefined)?.message ?? err.cause?.message);
    else throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
