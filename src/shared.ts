import type { Order } from './activities';

export const TASK_QUEUE = 'checkout';
export const ADDRESS = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';

export type Scenario = 'gateway-retry' | 'card-declined' | 'worker-crash' | 'happy';

/** The order for each scenario; the card token and address pick the behaviour in activities.ts. */
export function orderFor(scenario: Scenario, id: string): Order {
  const base = { id, sku: 'BOOK-42', quantity: 1, amountCents: 2599, address: '1 Main St' };
  switch (scenario) {
    case 'gateway-retry':
      return { ...base, cardToken: 'tok_gateway_flaky' };
    case 'card-declined':
      return { ...base, cardToken: 'tok_declined' };
    case 'worker-crash':
      return { ...base, cardToken: 'tok_ok', address: '9 Elm St (slow-carrier)' };
    case 'happy':
      return { ...base, cardToken: 'tok_ok' };
  }
}
