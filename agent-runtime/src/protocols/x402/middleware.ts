/**
 * x402 Payment Verification Middleware
 *
 * HTTP middleware that enforces x402 payments on configured routes.
 *
 * A request is served only when its `X-PAYMENT` header:
 *   1. names this agent as payee, the configured chain, and the route's token;
 *   2. covers the route's price;
 *   3. carries a valid EIP-712 signature from the payer over every field,
 *      including the hash of the transfer that paid for it;
 *   4. points at a successful on-chain ERC-20 transfer of at least the price,
 *      from the payer to the payee, emitted by the route's token contract,
 *      mined within `maxPaymentAgeSeconds`;
 *   5. has not already been used to pay for another request.
 */

import type { Context, Next } from 'hono';
import { ethers } from 'ethers';
import type {
  X402PricingConfig,
  X402PaymentHeader,
  X402PaymentRequired,
  PaymentVerification,
} from './types.js';
import { verifyPaymentHeader } from '../../utils/crypto.js';
import { resolveChain, type ChainConfig } from '../../utils/chains.js';
import { PaymentFacilitator } from './facilitator.js';

export interface X402MiddlewareConfig {
  /** Route pricing configurations */
  routes: X402PricingConfig[];
  /** Payee wallet address */
  payeeAddress: string;
  /** Chain ID for payment verification */
  chainId: number;
  /** Optional: facilitator URL for delegated verification */
  facilitatorUrl?: string;
  /** Optional: skip verification in development mode */
  devMode?: boolean;
  /** Chain used for on-chain settlement checks (default: resolved from `chainId`) */
  chain?: ChainConfig;
  /** Facilitator used for settlement checks and receipt tracking */
  facilitator?: PaymentFacilitator;
  /**
   * Resolve the priced route for a request. Return `null` for requests that
   * are never charged. Default: the request path.
   */
  resolveRoute?: (c: Context) => string | null | Promise<string | null>;
  /** Reject transfers mined longer ago than this (default: 600 seconds) */
  maxPaymentAgeSeconds?: number;
  /** Confirmations required before a transfer is accepted (default: 1) */
  minConfirmations?: number;
}

interface PricedRoute {
  pricing: X402PricingConfig;
  /** Price in the token's smallest unit */
  requiredAmount: bigint;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^[0-9]{1,78}$/;
const DEFAULT_MAX_PAYMENT_AGE_SECONDS = 600;

/**
 * Create x402 payment enforcement middleware for Hono.
 *
 * Throws at construction when a priced route has no valid token address or an
 * unparseable price, unless `devMode` is set.
 */
export function createX402Middleware(config: X402MiddlewareConfig) {
  const routeMap = new Map<string, PricedRoute>();
  for (const pricing of config.routes) {
    routeMap.set(normalizeRoute(pricing.route), priceRoute(pricing, config.devMode === true));
  }

  const maxAge = config.maxPaymentAgeSeconds ?? DEFAULT_MAX_PAYMENT_AGE_SECONDS;
  const minConfirmations = config.minConfirmations ?? 1;
  const chain = config.devMode ? config.chain : config.chain ?? resolveChain(config.chainId);
  const facilitator =
    config.facilitator ??
    new PaymentFacilitator({ chainId: config.chainId, payeeAddress: config.payeeAddress, tokens: [] });
  const replay = new ReplayGuard();

  return async (c: Context, next: Next) => {
    let route: string | null;
    try {
      route = config.resolveRoute ? await config.resolveRoute(c) : c.req.path;
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
    if (route === null) return next();

    const priced = findMatchingRoute(normalizeRoute(route), routeMap);
    if (!priced) return next();

    if (config.devMode) {
      c.set('x402Payment', { verified: true, devMode: true });
      return next();
    }

    const paymentHeader = c.req.header('X-PAYMENT');
    if (!paymentHeader) {
      return c.json(buildPaymentRequired(priced, config), 402);
    }

    const payment = parsePaymentHeader(paymentHeader);
    if (!payment) {
      return rejected(c, 'Invalid payment header');
    }

    const failure = checkPaymentFields(payment, priced, config);
    if (failure) {
      return rejected(c, failure);
    }

    const txKey = payment.txHash.toLowerCase();
    if (!replay.reserve(txKey)) {
      return rejected(c, 'Payment already used');
    }

    let transfer: Awaited<ReturnType<PaymentFacilitator['getSettledTransfer']>>;
    try {
      transfer = await facilitator.getSettledTransfer(payment, chain!, minConfirmations);
    } catch {
      replay.release(txKey);
      c.header('Retry-After', '5');
      return c.json({ error: 'Payment verification unavailable' }, 503);
    }

    if (!transfer || transfer.amount < priced.requiredAmount) {
      replay.release(txKey);
      return rejected(c, 'Payment not found on-chain');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - transfer.blockTimestamp > maxAge) {
      replay.release(txKey);
      return rejected(c, 'Payment too old');
    }

    replay.consume(txKey, transfer.blockTimestamp + maxAge, nowSeconds);

    facilitator.recordReceipt({
      paymentId: txKey,
      payer: payment.payer,
      payee: payment.payee,
      amount: transfer.amount.toString(),
      token: payment.token,
      chainId: payment.chainId,
      txHash: payment.txHash,
      timestamp: transfer.blockTimestamp,
      route: priced.pricing.route,
    });

    const verification: PaymentVerification = {
      valid: true,
      payer: payment.payer,
      amount: transfer.amount.toString(),
      token: payment.token,
      chainId: payment.chainId,
      txHash: payment.txHash,
    };
    c.set('x402Payment', verification);
    return next();
  };
}

function rejected(c: Context, details: string) {
  return c.json({ error: 'Payment verification failed', details }, 402);
}

function priceRoute(pricing: X402PricingConfig, devMode: boolean): PricedRoute {
  if (pricing.decimals === undefined) {
    if (devMode) return { pricing, requiredAmount: 0n };
    throw new Error(`x402 route "${pricing.route}": token decimals unknown for ${pricing.token}; set decimals`);
  }
  const decimals = pricing.decimals;
  let requiredAmount: bigint;
  try {
    requiredAmount = ethers.parseUnits(pricing.price, decimals);
  } catch {
    if (devMode) return { pricing, requiredAmount: 0n };
    throw new Error(`x402 route "${pricing.route}": invalid price "${pricing.price}" for ${decimals} decimals`);
  }
  if (!devMode) {
    if (requiredAmount <= 0n) {
      throw new Error(`x402 route "${pricing.route}": price must be greater than zero`);
    }
    if (!pricing.tokenAddress || !ethers.isAddress(pricing.tokenAddress)) {
      throw new Error(
        `x402 route "${pricing.route}": no token contract address for ${pricing.token} on this chain; set tokenAddress`
      );
    }
  }
  return { pricing, requiredAmount };
}

/**
 * Decode and shape-check a base64 JSON `X-PAYMENT` header.
 */
function parsePaymentHeader(header: string): X402PaymentHeader | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  const p = decoded as Record<string, unknown>;

  const valid =
    p.version === '1' &&
    typeof p.payer === 'string' && ethers.isAddress(p.payer) &&
    typeof p.payee === 'string' && ethers.isAddress(p.payee) &&
    typeof p.token === 'string' && ethers.isAddress(p.token) &&
    typeof p.amount === 'string' && UINT.test(p.amount) &&
    typeof p.chainId === 'number' && Number.isSafeInteger(p.chainId) &&
    typeof p.txHash === 'string' && BYTES32.test(p.txHash) &&
    typeof p.nonce === 'string' && BYTES32.test(p.nonce) &&
    typeof p.expiry === 'number' && Number.isSafeInteger(p.expiry) &&
    typeof p.signature === 'string' && ethers.isHexString(p.signature);

  return valid ? (p as unknown as X402PaymentHeader) : null;
}

/**
 * Check the signed header against this agent's terms. Returns a failure
 * reason, or `null` when the header is acceptable pending on-chain settlement.
 */
function checkPaymentFields(
  payment: X402PaymentHeader,
  priced: PricedRoute,
  config: X402MiddlewareConfig
): string | null {
  if (payment.payee.toLowerCase() !== config.payeeAddress.toLowerCase()) return 'Payee mismatch';
  if (payment.chainId !== config.chainId) return 'Chain mismatch';
  if (payment.token.toLowerCase() !== priced.pricing.tokenAddress!.toLowerCase()) return 'Token mismatch';
  if (BigInt(payment.amount) < priced.requiredAmount) return 'Insufficient payment';
  if (payment.expiry < Date.now() / 1000) return 'Payment expired';

  try {
    const recovered = verifyPaymentHeader(
      {
        payer: payment.payer,
        payee: payment.payee,
        amount: payment.amount,
        token: payment.token,
        chainId: payment.chainId,
        txHash: payment.txHash,
        nonce: payment.nonce,
        expiry: payment.expiry,
      },
      payment.signature
    );
    if (recovered.toLowerCase() !== payment.payer.toLowerCase()) return 'Invalid signature';
  } catch {
    return 'Invalid signature';
  }
  return null;
}

/**
 * Tracks transfer hashes that already paid for a request.
 *
 * A hash is reserved while its settlement is being checked so concurrent
 * requests cannot spend it twice, then consumed until the transfer is old
 * enough that the age check rejects it anyway. State is per process.
 */
class ReplayGuard {
  private readonly consumed = new Map<string, number>();
  private readonly pending = new Set<string>();
  private nextPruneAt = 0;

  reserve(txKey: string): boolean {
    if (this.pending.has(txKey) || this.consumed.has(txKey)) return false;
    this.pending.add(txKey);
    return true;
  }

  release(txKey: string): void {
    this.pending.delete(txKey);
  }

  consume(txKey: string, expiresAt: number, nowSeconds: number): void {
    this.pending.delete(txKey);
    this.consumed.set(txKey, expiresAt);
    if (nowSeconds >= this.nextPruneAt) {
      for (const [key, expiry] of this.consumed) {
        if (expiry < nowSeconds) this.consumed.delete(key);
      }
      this.nextPruneAt = nowSeconds + 60;
    }
  }
}

/**
 * Build a 402 Payment Required response body.
 */
function buildPaymentRequired(
  priced: PricedRoute,
  config: X402MiddlewareConfig
): X402PaymentRequired {
  const { pricing } = priced;
  return {
    version: '1',
    accepts: [
      {
        network: 'evm',
        chainId: config.chainId,
        token: pricing.tokenAddress ?? pricing.token,
        symbol: pricing.token,
        amount: priced.requiredAmount.toString(),
        payee: config.payeeAddress,
        scheme: 'exact',
      },
    ],
    description: pricing.description ?? `Payment required: ${pricing.price} ${pricing.token}`,
  };
}

/**
 * Normalize a route path for matching.
 */
function normalizeRoute(route: string): string {
  return route.replace(/^\/+|\/+$/g, '').toLowerCase();
}

/**
 * Find the pricing for a route: an exact match, else the longest configured
 * route that is a whole-segment prefix of it.
 */
function findMatchingRoute(
  path: string,
  routeMap: Map<string, PricedRoute>
): PricedRoute | null {
  const exact = routeMap.get(path);
  if (exact) return exact;

  let best: { length: number; priced: PricedRoute } | null = null;
  for (const [route, priced] of routeMap) {
    if (route.length > 0 && path.startsWith(`${route}/`) && (!best || route.length > best.length)) {
      best = { length: route.length, priced };
    }
  }
  return best?.priced ?? null;
}
