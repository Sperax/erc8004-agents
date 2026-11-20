/**
 * x402 payment enforcement tests: middleware, on-chain settlement lookup,
 * A2A skill pricing, and client payment-method selection.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import { ethers } from 'ethers';
import type { AddressInfo } from 'node:net';
import { createX402Middleware } from '../src/protocols/x402/middleware.js';
import { PaymentFacilitator } from '../src/protocols/x402/facilitator.js';
import { PricingManager } from '../src/protocols/x402/pricing.js';
import { TaskManager } from '../src/protocols/a2a/taskManager.js';
import { createAgentServer } from '../src/server.js';
import { callAgent, selectPaymentMethod, PaymentRequiredError } from '../src/discovery/connect.js';
import { signPaymentHeader, generateNonce } from '../src/utils/crypto.js';
import { resolveChain } from '../src/utils/chains.js';
import { ERC20_ABI } from '../src/utils/contracts.js';
import type { X402PricingConfig } from '../src/protocols/x402/types.js';

const payer = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();
const PAYEE = ethers.Wallet.createRandom().address;
const TOKEN = '0x64544969ed7EBf5f083679233325356EbE738930';
const OTHER_TOKEN = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd';
const PRICE = 10n ** 15n; // 0.001 at 18 decimals
const chain = resolveChain('bsc-testnet');
const erc20 = new ethers.Interface(ERC20_ABI);

const ROUTE: X402PricingConfig = {
  route: 'paid/basic',
  price: '0.001',
  token: 'USDC',
  tokenAddress: TOKEN,
  decimals: 18,
};

function now(): number {
  return Math.floor(Date.now() / 1000);
}

interface HeaderFields {
  payer: string;
  payee: string;
  amount: string;
  token: string;
  chainId: number;
  txHash: string;
  nonce: string;
  expiry: number;
}

async function paymentHeader(
  overrides: Partial<HeaderFields> = {},
  signer: ethers.HDNodeWallet = payer
): Promise<{ fields: HeaderFields; encoded: string }> {
  const fields: HeaderFields = {
    payer: payer.address,
    payee: PAYEE,
    amount: PRICE.toString(),
    token: TOKEN,
    chainId: 97,
    txHash: ethers.hexlify(ethers.randomBytes(32)),
    nonce: generateNonce(),
    expiry: now() + 300,
    ...overrides,
  };
  const signature = await signPaymentHeader(signer.privateKey, fields);
  const encoded = Buffer.from(JSON.stringify({ version: '1', ...fields, signature })).toString('base64');
  return { fields, encoded };
}

function newFacilitator(): PaymentFacilitator {
  return new PaymentFacilitator({ chainId: 97, payeeAddress: PAYEE, tokens: [] });
}

describe('createX402Middleware', () => {
  let facilitator: PaymentFacilitator;
  let app: Hono;
  let settled: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    facilitator = newFacilitator();
    settled = vi
      .spyOn(facilitator, 'getSettledTransfer')
      .mockResolvedValue({ amount: PRICE, blockTimestamp: now() - 10, blockNumber: 100 });
    app = new Hono();
    app.use('*', createX402Middleware({ routes: [ROUTE], payeeAddress: PAYEE, chainId: 97, chain, facilitator }));
    app.all('*', (c) => c.json({ ok: true, payment: c.get('x402Payment') ?? null }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function get(path: string, header?: string) {
    return app.request(path, { headers: header ? { 'X-PAYMENT': header } : {} });
  }

  async function details(res: Response): Promise<string> {
    return ((await res.json()) as { details: string }).details;
  }

  it('answers 402 with the exact amount, token contract and payee when no header is sent', async () => {
    const res = await get('/paid/basic');
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<Record<string, unknown>> };
    expect(body.accepts).toEqual([
      expect.objectContaining({
        scheme: 'exact',
        network: 'evm',
        chainId: 97,
        token: TOKEN,
        amount: PRICE.toString(),
        payee: PAYEE,
      }),
    ]);
  });

  it('serves the request and records a receipt for a settled payment', async () => {
    const { fields, encoded } = await paymentHeader();
    const res = await get('/paid/basic', encoded);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payment: Record<string, unknown> };
    expect(body.payment).toMatchObject({ valid: true, payer: payer.address, txHash: fields.txHash });
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ txHash: fields.txHash }), chain, 1);
    expect(facilitator.getReceipt(fields.txHash.toLowerCase())).toMatchObject({ route: 'paid/basic' });
  });

  it('rejects a transfer hash that already paid for a request', async () => {
    const { encoded } = await paymentHeader();
    expect((await get('/paid/basic', encoded)).status).toBe(200);
    const replay = await get('/paid/basic', encoded);
    expect(replay.status).toBe(402);
    expect(await details(replay)).toBe('Payment already used');
  });

  it('lets only one of two concurrent requests spend the same transfer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    settled.mockImplementation(async () => {
      await gate;
      return { amount: PRICE, blockTimestamp: now() - 10, blockNumber: 100 };
    });
    const { encoded } = await paymentHeader();
    const first = get('/paid/basic', encoded);
    const second = get('/paid/basic', encoded);
    release();
    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 402]);
  });

  it('rejects when no matching transfer is found on-chain', async () => {
    settled.mockResolvedValue(null);
    const res = await get('/paid/basic', (await paymentHeader()).encoded);
    expect(res.status).toBe(402);
    expect(await details(res)).toBe('Payment not found on-chain');
  });

  it('rejects when the on-chain transfer is below the price even if the header claims more', async () => {
    settled.mockResolvedValue({ amount: PRICE - 1n, blockTimestamp: now() - 10, blockNumber: 100 });
    const res = await get('/paid/basic', (await paymentHeader({ amount: (PRICE * 10n).toString() })).encoded);
    expect(res.status).toBe(402);
    expect(await details(res)).toBe('Payment not found on-chain');
  });

  it('rejects a transfer mined before the payment age window', async () => {
    settled.mockResolvedValue({ amount: PRICE, blockTimestamp: now() - 3600, blockNumber: 100 });
    const res = await get('/paid/basic', (await paymentHeader()).encoded);
    expect(res.status).toBe(402);
    expect(await details(res)).toBe('Payment too old');
  });

  it('answers 503 when settlement cannot be checked and accepts the same payment once the RPC recovers', async () => {
    settled.mockRejectedValueOnce(new Error('rpc down'));
    const { encoded } = await paymentHeader();
    const unavailable = await get('/paid/basic', encoded);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('5');
    expect(await unavailable.json()).toEqual({ error: 'Payment verification unavailable' });

    expect((await get('/paid/basic', encoded)).status).toBe(200);
  });

  it('rejects a header signed by someone other than the payer', async () => {
    const res = await get('/paid/basic', (await paymentHeader({}, stranger)).encoded);
    expect(res.status).toBe(402);
    expect(await details(res)).toBe('Invalid signature');
    expect(settled).not.toHaveBeenCalled();
  });

  it('rejects a header whose fields were changed after signing', async () => {
    const { fields, encoded } = await paymentHeader();
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    decoded.txHash = ethers.hexlify(ethers.randomBytes(32));
    expect(decoded.txHash).not.toBe(fields.txHash);
    const res = await get('/paid/basic', Buffer.from(JSON.stringify(decoded)).toString('base64'));
    expect(res.status).toBe(402);
    expect(await details(res)).toBe('Invalid signature');
  });

  it.each([
    ['Token mismatch', { token: OTHER_TOKEN }],
    ['Payee mismatch', { payee: stranger.address }],
    ['Chain mismatch', { chainId: 56 }],
    ['Insufficient payment', { amount: (PRICE - 1n).toString() }],
    ['Payment expired', { expiry: now() - 1 }],
  ] as const)('rejects with "%s"', async (reason, overrides) => {
    const res = await get('/paid/basic', (await paymentHeader(overrides)).encoded);
    expect(res.status).toBe(402);
    expect(await details(res)).toBe(reason);
    expect(settled).not.toHaveBeenCalled();
  });

  it.each([
    ['not base64 JSON', '%%%'],
    ['a JSON array', Buffer.from('[]').toString('base64')],
    ['missing txHash', Buffer.from(JSON.stringify({ version: '1', payer: payer.address })).toString('base64')],
  ])('rejects a header that is %s', async (_label, header) => {
    const res = await get('/paid/basic', header);
    expect(res.status).toBe(402);
    expect(await details(res)).toBe('Invalid payment header');
  });

  it('prices sub-paths by whole-segment prefix but not look-alike routes', async () => {
    expect((await get('/paid/basic/extra')).status).toBe(402);
    expect((await get('/PAID/BASIC/')).status).toBe(402);
    expect((await get('/paid/basically')).status).toBe(200);
    expect((await get('/free/paid/basic')).status).toBe(200);
  });

  it('passes unpriced routes through without payment', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
  });

  describe('startup validation', () => {
    it('throws for a priced route with unknown decimals', () => {
      expect(() =>
        createX402Middleware({
          routes: [{ route: 'x', price: '1', token: 'DAI', tokenAddress: TOKEN }],
          payeeAddress: PAYEE,
          chainId: 97,
          chain,
        })
      ).toThrow(/decimals/);
    });

    it('throws for a priced route without a token contract address', () => {
      expect(() =>
        createX402Middleware({
          routes: [{ route: 'x', price: '1', token: 'USDC', decimals: 6 }],
          payeeAddress: PAYEE,
          chainId: 1,
          chain: resolveChain('ethereum'),
        })
      ).toThrow(/tokenAddress/);
    });

    it('throws for a zero or unparseable price', () => {
      for (const price of ['0', 'abc', '0.0000001']) {
        expect(() =>
          createX402Middleware({
            routes: [{ ...ROUTE, price, decimals: 6 }],
            payeeAddress: PAYEE,
            chainId: 97,
            chain,
          })
        ).toThrow();
      }
    });

    it('allows incomplete pricing in devMode and marks requests as dev payments', async () => {
      const dev = new Hono();
      dev.use('*', createX402Middleware({
        routes: [{ route: 'x', price: '1', token: 'DAI' }],
        payeeAddress: PAYEE,
        chainId: 1,
        devMode: true,
      }));
      dev.get('*', (c) => c.json({ payment: c.get('x402Payment') }));
      const res = await dev.request('/x');
      expect(await res.json()).toEqual({ payment: { verified: true, devMode: true } });
    });
  });
});

describe('PaymentFacilitator.getSettledTransfer', () => {
  const txHash = ethers.hexlify(ethers.randomBytes(32));
  const query = { txHash, payer: payer.address, payee: PAYEE, token: TOKEN };

  function transferLog(address: string, from: string, to: string, value: bigint) {
    const { data, topics } = erc20.encodeEventLog('Transfer', [from, to, value]);
    return { address, data, topics };
  }

  function mockReceipt(logs: ReturnType<typeof transferLog>[], status = 1) {
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValue({
      status,
      logs,
      blockNumber: 1234,
      confirmations: async () => 3,
    } as unknown as ethers.TransactionReceipt);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBlock').mockResolvedValue({
      timestamp: 1_700_000_000,
    } as unknown as ethers.Block);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sums Transfer logs from the payment token, payer to payee', async () => {
    mockReceipt([
      transferLog(TOKEN, payer.address, PAYEE, PRICE),
      transferLog(TOKEN, payer.address, PAYEE, 5n),
    ]);
    await expect(newFacilitator().getSettledTransfer(query, chain)).resolves.toEqual({
      amount: PRICE + 5n,
      blockTimestamp: 1_700_000_000,
      blockNumber: 1234,
    });
  });

  it('ignores Transfer logs emitted by another contract', async () => {
    mockReceipt([transferLog(OTHER_TOKEN, payer.address, PAYEE, PRICE)]);
    await expect(newFacilitator().getSettledTransfer(query, chain)).resolves.toBeNull();
  });

  it('ignores transfers to another recipient or from another sender', async () => {
    mockReceipt([
      transferLog(TOKEN, payer.address, stranger.address, PRICE),
      transferLog(TOKEN, stranger.address, PAYEE, PRICE),
    ]);
    await expect(newFacilitator().getSettledTransfer(query, chain)).resolves.toBeNull();
  });

  it('returns null for a reverted transaction', async () => {
    mockReceipt([transferLog(TOKEN, payer.address, PAYEE, PRICE)], 0);
    await expect(newFacilitator().getSettledTransfer(query, chain)).resolves.toBeNull();
  });

  it('returns null when the transaction is below the required confirmations', async () => {
    mockReceipt([transferLog(TOKEN, payer.address, PAYEE, PRICE)]);
    await expect(newFacilitator().getSettledTransfer(query, chain, 5)).resolves.toBeNull();
  });

  it('throws on RPC failure so callers can tell unverifiable from unpaid', async () => {
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockRejectedValue(new Error('timeout'));
    await expect(newFacilitator().getSettledTransfer(query, chain)).rejects.toThrow('timeout');
  });

  it('verifyOnChainPayment compares the settled total with the header amount', async () => {
    mockReceipt([transferLog(TOKEN, payer.address, PAYEE, PRICE)]);
    const facilitator = newFacilitator();
    const header = { ...(await paymentHeader({ txHash })).fields, version: '1' as const, signature: '0x' };
    await expect(facilitator.verifyOnChainPayment(header, chain)).resolves.toBe(true);
    await expect(
      facilitator.verifyOnChainPayment({ ...header, amount: (PRICE + 1n).toString() }, chain)
    ).resolves.toBe(false);
  });
});

describe('PricingManager token resolution', () => {
  it('resolves bundled BSC testnet tokens', () => {
    const manager = new PricingManager(97);
    manager.addFromConfig({ a: { price: '1', token: 'usdc' } });
    expect(manager.getRoutePrice('a')).toMatchObject({ tokenAddress: TOKEN, decimals: 18 });
  });

  it('does not apply BSC token addresses on other chains', () => {
    const manager = new PricingManager(1);
    manager.addFromConfig({ a: { price: '1', token: 'USDC' } });
    expect(manager.getRoutePrice('a')).toMatchObject({ tokenAddress: undefined, decimals: undefined });
  });
});

describe('A2A server pricing', () => {
  let server: ReturnType<typeof createAgentServer>;
  let baseUrl: string;
  let facilitator: PaymentFacilitator;

  beforeAll(async () => {
    const taskManager = new TaskManager();
    taskManager.registerHandler('paid/basic', async () => ({ status: 'completed', result: { paid: true } }));
    taskManager.registerHandler('free/echo', async () => ({ status: 'completed', result: { free: true } }));
    const pricingManager = new PricingManager(97);
    pricingManager.addFromConfig({ 'paid/basic': { price: '0.001', token: 'USDC' } });
    facilitator = newFacilitator();

    server = createAgentServer({
      agentCard: {
        name: 'Test',
        description: 'Test agent',
        url: 'http://127.0.0.1',
        version: '1.0.0',
        capabilities: {},
        skills: [],
      },
      taskManager,
      pricingManager,
      payeeAddress: PAYEE,
      chainId: 97,
      chain: 'bsc-testnet',
      facilitator,
      port: 0,
      hostname: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.once('listening', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function rpc(method: string, params: Record<string, unknown>, paymentHeaderValue?: string) {
    return fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(paymentHeaderValue ? { 'X-PAYMENT': paymentHeaderValue } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  function send(id: string, extra: Record<string, unknown>, paymentHeaderValue?: string) {
    return rpc('tasks/send', { id, message: { role: 'user', parts: [] }, ...extra }, paymentHeaderValue);
  }

  it('charges a priced skill named in metadata', async () => {
    const res = await send('t1', { metadata: { skill: 'paid/basic' } });
    expect(res.status).toBe(402);
  });

  it('charges a priced skill named in a data part', async () => {
    const res = await rpc('tasks/send', {
      id: 't2',
      message: { role: 'user', parts: [{ type: 'data', data: { task: 'paid/basic' } }] },
    });
    expect(res.status).toBe(402);
  });

  it('charges a priced skill matched from message text', async () => {
    const res = await rpc('tasks/send', {
      id: 't3',
      message: { role: 'user', parts: [{ type: 'text', text: 'please run paid/basic now' }] },
    });
    expect(res.status).toBe(402);
  });

  it('runs a priced skill once a settled payment is presented', async () => {
    vi.spyOn(facilitator, 'getSettledTransfer').mockResolvedValue({
      amount: PRICE,
      blockTimestamp: now() - 5,
      blockNumber: 1,
    });
    const res = await send('t4', { metadata: { skill: 'paid/basic' } }, (await paymentHeader()).encoded);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { status: { state: string } } };
    expect(body.result.status.state).toBe('completed');
  });

  it('does not charge unpriced skills or task queries', async () => {
    expect((await send('t5', { metadata: { skill: 'free/echo' } })).status).toBe(200);
    expect((await rpc('tasks/get', { id: 't5' })).status).toBe(200);
  });
});

describe('callAgent payment', () => {
  const connection = {
    agentId: 1,
    name: 'Remote',
    endpoint: 'http://agent.invalid',
    card: {} as never,
  };
  const quote = {
    version: '1',
    accepts: [
      { network: 'evm', chainId: 97, token: TOKEN, symbol: 'USDC', amount: PRICE.toString(), payee: PAYEE, scheme: 'exact' },
    ],
    description: 'Payment required',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects the quoted method on the caller chain and token within the cap', () => {
    expect(selectPaymentMethod(quote, { token: TOKEN.toLowerCase(), maxAmount: PRICE.toString() }, 97)).toEqual(
      quote.accepts[0]
    );
  });

  it.each([
    ['over the cap', { token: TOKEN, maxAmount: (PRICE - 1n).toString() }, 97],
    ['another token', { token: OTHER_TOKEN, maxAmount: PRICE.toString() }, 97],
    ['another chain', { token: TOKEN, maxAmount: PRICE.toString() }, 56],
    ['an invalid cap', { token: TOKEN, maxAmount: 'lots' }, 97],
  ])('selects nothing for %s', (_label, payment, chainId) => {
    expect(selectPaymentMethod(quote, payment, chainId)).toBeNull();
  });

  it('selects nothing when the payee is not an address', () => {
    const bad = { ...quote, accepts: [{ ...quote.accepts[0], payee: 'http://agent.invalid' }] };
    expect(selectPaymentMethod(bad, { token: TOKEN, maxAmount: PRICE.toString() }, 97)).toBeNull();
  });

  it('throws PaymentRequiredError without paying when no payment cap is given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(quote), { status: 402 }));
    const call = callAgent(connection, { task: 'paid/basic', data: {} }, { privateKey: payer.privateKey, chainId: 97 });
    await expect(call).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws PaymentRequiredError without paying when the quote exceeds the cap', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(quote), { status: 402 }));
    const call = callAgent(
      connection,
      { task: 'paid/basic', data: {}, payment: { token: TOKEN, maxAmount: '1' } },
      { privateKey: payer.privateKey, chainId: 97 }
    );
    await expect(call).rejects.toThrow('No acceptable payment method within the caller limit');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
