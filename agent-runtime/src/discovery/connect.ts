/**
 * Agent Connection
 *
 * Connect to another ERC-8004 agent and make A2A calls with x402 payments.
 */

import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import type { AgentCard, Task, TaskSendParams, A2ARequest, A2AResponse } from '../protocols/a2a/types.js';
import type {
  X402PaymentHeader,
  X402PaymentMethod,
  X402PaymentRequired,
} from '../protocols/x402/types.js';
import { signPaymentHeader, generateNonce } from '../utils/crypto.js';
import { ERC20_ABI } from '../utils/contracts.js';
import { resolveChain } from '../utils/chains.js';
import { fetchAgentCard } from './search.js';

export interface AgentConnection {
  agentId: number;
  name: string;
  endpoint: string;
  card: AgentCard;
}

export interface CallPaymentOptions {
  /** Token contract address the caller is willing to pay with */
  token: string;
  /** Most the caller will pay for this call, in the token's smallest unit */
  maxAmount: string;
}

export interface CallOptions {
  /** Task type / skill to invoke */
  task: string;
  /** Data payload */
  data: Record<string, unknown>;
  /** Session ID for multi-turn conversations */
  sessionId?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /**
   * Pay the agent's x402 price when it asks for one, up to `maxAmount`.
   * Without this, a 402 response throws `PaymentRequiredError`.
   */
  payment?: CallPaymentOptions;
}

export interface CallerConfig {
  privateKey: string;
  chainId: number;
  /** RPC used to send the payment transfer (default: the chain's bundled RPC) */
  rpcUrl?: string;
}

const PAYMENT_HEADER_TTL_SECONDS = 300;

/**
 * Connect to a remote ERC-8004 agent.
 */
export async function connectToAgent(
  endpoint: string,
  agentId?: number
): Promise<AgentConnection> {
  const card = await fetchAgentCard(endpoint);
  if (!card) {
    throw new Error(`Failed to fetch agent card from ${endpoint}`);
  }

  return {
    agentId: agentId ?? card.erc8004?.agentId ?? 0,
    name: card.name,
    endpoint,
    card,
  };
}

/**
 * Call a remote agent via A2A.
 *
 * When the agent answers 402 and `options.payment` plus `callerConfig` are
 * given, the caller sends an ERC-20 transfer for the quoted amount (never more
 * than `payment.maxAmount`), waits for it to be mined, signs an x402 header
 * bound to the transfer hash, and retries once.
 */
export async function callAgent(
  connection: AgentConnection,
  options: CallOptions,
  callerConfig?: CallerConfig
): Promise<Task> {
  const taskId = uuidv4();
  const sessionId = options.sessionId ?? uuidv4();

  const sendParams: TaskSendParams = {
    id: taskId,
    sessionId,
    message: {
      role: 'user',
      parts: [
        {
          type: 'data',
          data: {
            task: options.task,
            ...options.data,
          },
        },
      ],
    },
    metadata: {
      skill: options.task,
    },
  };

  const a2aRequest: A2ARequest = {
    jsonrpc: '2.0',
    id: taskId,
    method: 'tasks/send',
    params: sendParams,
  };

  const a2aUrl = `${connection.endpoint}/a2a`;
  const body = JSON.stringify(a2aRequest);
  const timeout = options.timeout ?? 30000;

  let response = await postA2A(a2aUrl, body, timeout);

  if (response.status === 402) {
    const paymentRequired = (await response.json()) as Record<string, unknown>;
    if (!options.payment || !callerConfig) {
      throw new PaymentRequiredError('Payment required', paymentRequired);
    }

    const method = selectPaymentMethod(paymentRequired, options.payment, callerConfig.chainId);
    if (!method) {
      throw new PaymentRequiredError('No acceptable payment method within the caller limit', paymentRequired);
    }

    const header = await payAndSign(method, callerConfig);
    response = await postA2A(a2aUrl, body, timeout, encodePaymentHeader(header));

    if (response.status === 402) {
      const rejection = (await response.json()) as Record<string, unknown>;
      throw new PaymentRequiredError('Payment rejected', { ...rejection, txHash: header.txHash });
    }
  }

  if (!response.ok) {
    throw new Error(`A2A call failed: ${response.status} ${response.statusText}`);
  }

  const a2aResponse = (await response.json()) as A2AResponse;

  if (a2aResponse.error) {
    throw new A2ACallError(
      a2aResponse.error.message,
      a2aResponse.error.code
    );
  }

  return a2aResponse.result as Task;
}

function postA2A(url: string, body: string, timeout: number, paymentHeader?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (paymentHeader) headers['X-PAYMENT'] = paymentHeader;
  return fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeout),
  });
}

/**
 * Pick the `exact` EVM method on the caller's chain and token whose amount is
 * within the caller's limit.
 */
export function selectPaymentMethod(
  paymentRequired: Record<string, unknown>,
  payment: CallPaymentOptions,
  chainId: number
): X402PaymentMethod | null {
  const accepts = (paymentRequired as Partial<X402PaymentRequired>).accepts;
  if (!Array.isArray(accepts)) return null;

  let maxAmount: bigint;
  try {
    maxAmount = BigInt(payment.maxAmount);
  } catch {
    return null;
  }

  for (const method of accepts) {
    if (
      method?.scheme === 'exact' &&
      method.network === 'evm' &&
      method.chainId === chainId &&
      typeof method.token === 'string' &&
      method.token.toLowerCase() === payment.token.toLowerCase() &&
      typeof method.payee === 'string' &&
      ethers.isAddress(method.payee) &&
      typeof method.amount === 'string' &&
      /^[0-9]{1,78}$/.test(method.amount)
    ) {
      const amount = BigInt(method.amount);
      if (amount > 0n && amount <= maxAmount) return method;
    }
  }
  return null;
}

/**
 * Transfer the quoted amount to the payee and sign a header bound to the
 * mined transfer.
 */
async function payAndSign(
  method: X402PaymentMethod,
  callerConfig: CallerConfig
): Promise<X402PaymentHeader> {
  const rpcUrl = callerConfig.rpcUrl ?? resolveChain(callerConfig.chainId).rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl, callerConfig.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(callerConfig.privateKey, provider);
  const token = new ethers.Contract(method.token, ERC20_ABI, wallet);

  const tx = (await token.transfer(method.payee, BigInt(method.amount))) as ethers.ContractTransactionResponse;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`x402 payment transfer ${tx.hash} failed`);
  }

  const paymentData = {
    payer: wallet.address,
    payee: method.payee,
    amount: method.amount,
    token: method.token,
    chainId: callerConfig.chainId,
    txHash: receipt.hash,
    nonce: generateNonce(),
    expiry: Math.floor(Date.now() / 1000) + PAYMENT_HEADER_TTL_SECONDS,
  };

  const signature = await signPaymentHeader(callerConfig.privateKey, paymentData);
  return { version: '1', ...paymentData, signature };
}

function encodePaymentHeader(header: X402PaymentHeader): string {
  return Buffer.from(JSON.stringify(header)).toString('base64');
}

/**
 * Error thrown when agent requires payment.
 */
export class PaymentRequiredError extends Error {
  readonly paymentDetails: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'PaymentRequiredError';
    this.paymentDetails = details;
  }
}

/**
 * Error thrown when an A2A call fails.
 */
export class A2ACallError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'A2ACallError';
    this.code = code;
  }
}
