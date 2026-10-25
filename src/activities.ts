import { ApplicationFailure, activityInfo, log } from '@temporalio/activity';

export interface Order {
  id: string;
  sku: string;
  quantity: number;
  amountCents: number;
  cardToken: string;
  address: string;
}

// Stand-ins for real services. The scenario rides on the order so every run is reproducible:
//   tok_gateway_flaky  the payment gateway returns 503 on the first two attempts
//   tok_declined       the card is declined (a business "no", not an outage)
//   "(slow-carrier)"   in the address: the shipment call takes CARRIER_DELAY_MS
// Every call uses the order id as its idempotency key, so a retry can't apply twice.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createOrder(order: Order): Promise<void> {
  log.info('order created', { orderId: order.id });
}

export async function cancelOrder(order: Order): Promise<void> {
  // Idempotent: cancelling an order that was never created, or twice, is a no-op.
  log.info('order cancelled', { orderId: order.id });
}

export async function reserveInventory(order: Order): Promise<void> {
  log.info('stock reserved', { orderId: order.id, sku: order.sku, quantity: order.quantity });
}

export async function releaseInventory(order: Order): Promise<void> {
  log.info('stock released', { orderId: order.id });
}

export async function chargePayment(order: Order): Promise<string> {
  const { attempt } = activityInfo();
  if (order.cardToken === 'tok_gateway_flaky' && attempt < 3) {
    // A retryable error: Temporal backs off and tries again.
    throw ApplicationFailure.retryable('payment gateway returned 503', 'GatewayUnavailable');
  }
  if (order.cardToken === 'tok_declined') {
    // Retrying won't change the answer, so fail at once.
    throw ApplicationFailure.nonRetryable('card declined: insufficient funds', 'CardDeclined');
  }
  log.info('card charged', { orderId: order.id, amountCents: order.amountCents, idempotencyKey: order.id });
  return `ch_${order.id}`;
}

export async function refundPayment(order: Order): Promise<void> {
  // Idempotent: refunds only a charge made under this order's key, so it's safe when nothing was charged.
  log.info('refund checked', { orderId: order.id });
}

export async function createShipment(order: Order): Promise<string> {
  if (order.address.includes('slow-carrier')) await delay(Number(process.env.CARRIER_DELAY_MS ?? 0));
  log.info('shipment created', { orderId: order.id, attempt: activityInfo().attempt });
  return `shp_${order.id}`;
}

export async function sendConfirmation(order: Order, shipmentId: string): Promise<void> {
  log.info('confirmation sent', { orderId: order.id, shipmentId });
}
