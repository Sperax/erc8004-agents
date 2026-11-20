/**
 * Cryptographic Utilities
 *
 * Signing, verification, and hashing helpers.
 */

import { ethers } from 'ethers';

/**
 * Sign a message with a private key.
 */
export async function signMessage(
  privateKey: string,
  message: string
): Promise<string> {
  const wallet = new ethers.Wallet(privateKey);
  return wallet.signMessage(message);
}

/**
 * Verify a signed message and return the signer address.
 */
export function verifyMessage(
  message: string,
  signature: string
): string {
  return ethers.verifyMessage(message, signature);
}

/**
 * Sign typed data (EIP-712).
 */
export async function signTypedData(
  privateKey: string,
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>
): Promise<string> {
  const wallet = new ethers.Wallet(privateKey);
  return wallet.signTypedData(domain, types, value);
}

/**
 * Verify EIP-712 typed data signature.
 */
export function verifyTypedData(
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>,
  signature: string
): string {
  return ethers.verifyTypedData(domain, types, value, signature);
}

/**
 * Generate a random nonce (hex string).
 */
export function generateNonce(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

/**
 * Hash data using keccak256.
 */
export function keccak256(data: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(data));
}

/**
 * Compute address from private key.
 */
export function privateKeyToAddress(privateKey: string): string {
  const wallet = new ethers.Wallet(privateKey);
  return wallet.address;
}

/**
 * Fields covered by an x402 payment header signature.
 * `txHash` binds the signature to the on-chain transfer that paid for the request.
 */
export interface PaymentHeaderData {
  payer: string;
  payee: string;
  amount: string;
  token: string;
  chainId: number;
  txHash: string;
  nonce: string;
  expiry: number;
}

const PAYMENT_TYPES = {
  Payment: [
    { name: 'payer', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'txHash', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
};

function paymentDomain(chainId: number): ethers.TypedDataDomain {
  return { name: 'x402Payment', version: '1', chainId };
}

/**
 * Sign an x402 payment header.
 */
export async function signPaymentHeader(
  privateKey: string,
  paymentData: PaymentHeaderData
): Promise<string> {
  return signTypedData(privateKey, paymentDomain(paymentData.chainId), PAYMENT_TYPES, { ...paymentData });
}

/**
 * Verify an x402 payment header signature and return the recovered signer.
 */
export function verifyPaymentHeader(
  paymentData: PaymentHeaderData,
  signature: string
): string {
  return verifyTypedData(paymentDomain(paymentData.chainId), PAYMENT_TYPES, { ...paymentData }, signature);
}
