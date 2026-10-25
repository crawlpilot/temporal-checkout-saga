import { CancellationScope, log, proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';
import type { Order } from './activities';

// Forward steps: retry transient failures with backoff; a business "no" fails at once.
const { createOrder, reserveInventory, chargePayment, createShipment, sendConfirmation } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '10 seconds',
    retry: {
      initialInterval: '1 second',
      backoffCoefficient: 2,
      maximumInterval: '1 minute',
      nonRetryableErrorTypes: ['CardDeclined', 'OutOfStock'],
    },
  });

// Compensations: never give up (the default retry policy has no attempt limit).
const { cancelOrder, releaseInventory, refundPayment } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
});

export async function checkout(order: Order): Promise<string> {
  const compensations: Array<() => Promise<void>> = [];
  try {
    // Register each undo before its step: a step can fail after it took effect.
    compensations.unshift(() => cancelOrder(order));
    await createOrder(order);
    compensations.unshift(() => releaseInventory(order));
    await reserveInventory(order);
    compensations.unshift(() => refundPayment(order));
    await chargePayment(order);
  } catch (err) {
    await compensate(compensations);
    throw err;
  }

  // The pivot: money has moved. From here we retry forward and never undo.
  const shipmentId = await createShipment(order);
  await sendConfirmation(order, shipmentId);
  return shipmentId;
}

async function compensate(compensations: Array<() => Promise<void>>): Promise<void> {
  // Run even if the workflow is being cancelled, newest first, and keep going past a failure.
  await CancellationScope.nonCancellable(async () => {
    for (const undo of compensations) {
      try {
        await undo();
      } catch (err) {
        log.error('compensation failed', { error: String(err) });
      }
    }
  });
}
