/**
 * x402 Payment Facilitator
 *
 * Verifies on-chain settlement of x402 payments and tracks receipts.
 */

import { ethers } from 'ethers';
import type {
  FacilitatorConfig,
  TokenConfig,
  PaymentReceipt,
  X402PaymentHeader,
} from './types.js';
import { ERC20_ABI } from '../../utils/contracts.js';
import type { ChainConfig } from '../../utils/chains.js';

const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);
const TRANSFER_TOPIC = ERC20_INTERFACE.getEvent('Transfer')!.topicHash;

/** The payment fields needed to locate a settled transfer. */
export type SettlementQuery = Pick<X402PaymentHeader, 'txHash' | 'payer' | 'payee' | 'token'>;

/** An ERC-20 transfer from payer to payee confirmed on-chain. */
export interface SettledTransfer {
  /** Total amount the payer sent the payee in the transaction, in the token's smallest unit */
  amount: bigint;
  /** Timestamp of the block that included the transaction (seconds) */
  blockTimestamp: number;
  /** Block number that included the transaction */
  blockNumber: number;
}

export class PaymentFacilitator {
  private readonly config: FacilitatorConfig;
  private readonly receipts: Map<string, PaymentReceipt> = new Map();
  private readonly providers: Map<string, ethers.JsonRpcProvider> = new Map();

  constructor(config: FacilitatorConfig) {
    this.config = config;
  }

  /**
   * Look up the transfer a payment points at.
   *
   * Only `Transfer` logs emitted by the payment token contract, from the payer
   * to the payee, are counted; their values are summed. Returns `null` when the
   * transaction is unknown, reverted, under-confirmed, or moved no matching
   * tokens. RPC failures throw so callers can tell "unpaid" from "unverifiable".
   */
  async getSettledTransfer(
    payment: SettlementQuery,
    chain: ChainConfig,
    minConfirmations = 1
  ): Promise<SettledTransfer | null> {
    if (!ethers.isHexString(payment.txHash, 32)) return null;
    if (!ethers.isAddress(payment.token) || !ethers.isAddress(payment.payer) || !ethers.isAddress(payment.payee)) {
      return null;
    }

    const provider = this.providerFor(chain);
    const receipt = await provider.getTransactionReceipt(payment.txHash);
    if (!receipt || receipt.status !== 1) return null;

    if (minConfirmations > 1 && (await receipt.confirmations()) < minConfirmations) {
      return null;
    }

    const token = payment.token.toLowerCase();
    const payer = payment.payer.toLowerCase();
    const payee = payment.payee.toLowerCase();

    let amount = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== token || log.topics[0] !== TRANSFER_TOPIC) continue;
      const parsed = ERC20_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const [from, to, value] = parsed.args as unknown as [string, string, bigint];
      if (from.toLowerCase() === payer && to.toLowerCase() === payee) {
        amount += value;
      }
    }
    if (amount === 0n) return null;

    const block = await provider.getBlock(receipt.blockNumber);
    if (!block) return null;

    return { amount, blockTimestamp: block.timestamp, blockNumber: receipt.blockNumber };
  }

  /**
   * Verify a payment on-chain: the transaction succeeded and transferred at
   * least `payment.amount` of `payment.token` from the payer to the payee.
   */
  async verifyOnChainPayment(
    payment: X402PaymentHeader,
    chain: ChainConfig
  ): Promise<boolean> {
    try {
      const transfer = await this.getSettledTransfer(payment, chain);
      return transfer !== null && transfer.amount >= BigInt(payment.amount);
    } catch {
      return false;
    }
  }

  /**
   * Record a payment receipt.
   */
  recordReceipt(receipt: PaymentReceipt): void {
    this.receipts.set(receipt.paymentId, receipt);
  }

  /**
   * Get a payment receipt.
   */
  getReceipt(paymentId: string): PaymentReceipt | undefined {
    return this.receipts.get(paymentId);
  }

  /**
   * Get all receipts for a route.
   */
  getReceiptsForRoute(route: string): PaymentReceipt[] {
    return Array.from(this.receipts.values()).filter(
      (r) => r.route === route
    );
  }

  /**
   * Get total revenue for a route.
   */
  getRouteRevenue(route: string): bigint {
    return this.getReceiptsForRoute(route).reduce(
      (sum, r) => sum + BigInt(r.amount),
      0n
    );
  }

  /**
   * Get total revenue across all routes.
   */
  getTotalRevenue(): bigint {
    return Array.from(this.receipts.values()).reduce(
      (sum, r) => sum + BigInt(r.amount),
      0n
    );
  }

  /**
   * Find a supported token by symbol.
   */
  findToken(symbol: string): TokenConfig | undefined {
    return this.config.tokens.find(
      (t) => t.symbol.toLowerCase() === symbol.toLowerCase()
    );
  }

  /**
   * Get the payee address.
   */
  get payeeAddress(): string {
    return this.config.payeeAddress;
  }

  private providerFor(chain: ChainConfig): ethers.JsonRpcProvider {
    const key = `${chain.chainId}:${chain.rpcUrl}`;
    let provider = this.providers.get(key);
    if (!provider) {
      provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
      this.providers.set(key, provider);
    }
    return provider;
  }
}
