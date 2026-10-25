import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { ADDRESS, TASK_QUEUE } from './shared';

async function main() {
  const connection = await NativeConnection.connect({ address: ADDRESS });
  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  console.log(`WORKER_READY pid=${process.pid} queue=${TASK_QUEUE}`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
