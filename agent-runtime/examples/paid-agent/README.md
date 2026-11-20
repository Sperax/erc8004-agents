# Paid Agent Example

An ERC-8004 agent with x402 micropayments — callers pay per request.

## Pricing Tiers

| Endpoint | Price | Description |
|----------|-------|-------------|
| `analysis/basic` | 0.0001 USDC | Basic sentiment analysis |
| `analysis/detailed` | 0.001 USDC | Detailed technical analysis |
| `prediction/price` | 0.005 USDC | Price prediction with confidence |

## Quick Start

```bash
PRIVATE_KEY=0x... npx tsx examples/paid-agent/index.ts
```

## How x402 Works

1. Client calls `/a2a` (`tasks/send` for a priced skill) without a payment header
2. Server returns **HTTP 402** with the amount in the token's smallest unit, the token contract, and the payee
3. Client transfers that amount on-chain, then retries with an `X-PAYMENT` header: the payment terms plus the transfer `txHash`, signed with EIP-712
4. Server checks the signature, confirms the transfer on-chain (token contract, payer, payee, amount, age), rejects reused transaction hashes, and processes the request

`agent.callAgent()` does steps 3 and 4 for you when you pass `payment: { token, maxAmount }`.

```bash
# Step 1: Try without payment (get 402)
curl -X POST http://localhost:3001/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tasks/send",
    "params": {
      "id": "test-1",
      "message": {
        "role": "user",
        "parts": [{"type": "data", "data": {"task": "analysis/basic", "token": "BNB"}}]
      }
    }
  }'

# Response: 402 Payment Required with pricing info
```

## Dev Mode

Run without a private key to skip x402 verification:

```bash
npx tsx examples/paid-agent/index.ts
# All endpoints accessible without payment
```
