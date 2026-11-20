/**
 * Agent Server
 *
 * Express/Hono server with A2A + x402 middleware, discovery endpoints, and health checks.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { AgentCard } from './protocols/a2a/types.js';
import type { A2ARequest, TaskSendParams } from './protocols/a2a/types.js';
import { A2AHandler } from './protocols/a2a/handler.js';
import { TaskManager } from './protocols/a2a/taskManager.js';
import { PricingManager } from './protocols/x402/pricing.js';
import { createX402Middleware } from './protocols/x402/middleware.js';
import type { PaymentFacilitator } from './protocols/x402/facilitator.js';
import { resolveChain } from './utils/chains.js';
import { createLoggingMiddleware } from './middleware/logging.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import {
  handleAgentJson,
  handleAgentCardJson,
  handleReputation,
  handleHealth,
  type WellKnownConfig,
} from './discovery/wellKnown.js';
import { generatePricingInfo } from './protocols/a2a/agentCard.js';
import type { AgentIdentity } from './protocols/erc8004/types.js';

export interface AgentServerConfig {
  agentCard: AgentCard;
  taskManager: TaskManager;
  pricingManager: PricingManager;
  payeeAddress: string;
  chainId: number;
  chain: string;
  devMode?: boolean;
  /** Facilitator that checks settlements and records receipts */
  facilitator?: PaymentFacilitator;
  identity?: AgentIdentity;
  port: number;
  hostname: string;
}

/**
 * Create and start the agent server with all middleware.
 */
export function createAgentServer(config: AgentServerConfig) {
  const app = new Hono();
  const startTime = Date.now();

  // ─── Global Middleware ──────────────────────────────────────────

  // CORS for browser-based agent discovery
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  }));

  // Structured logging
  app.use('*', createLoggingMiddleware({ level: 'info' }));

  // Rate limiting (reputation-based)
  app.use('*', createRateLimitMiddleware({
    baseRate: 60,
    reputationMultiplier: 0.5,
    maxRate: 300,
    chain: config.chain,
  }));

  // x402 payment middleware (only on A2A endpoint)
  const pricedRoutes = config.pricingManager.getAllRoutes();
  if (pricedRoutes.length > 0) {
    app.use('/a2a', createX402Middleware({
      routes: pricedRoutes,
      payeeAddress: config.payeeAddress,
      chainId: config.chainId,
      chain: resolveChain(config.chain),
      facilitator: config.facilitator,
      devMode: config.devMode,
      resolveRoute: async (c) => {
        if (c.req.method !== 'POST') return null;
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return null;
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
        const { method, params } = body as { method?: unknown; params?: unknown };
        if (method !== 'tasks/send' || typeof params !== 'object' || params === null) return null;
        return config.taskManager.resolveSkill(params as TaskSendParams);
      },
    }));
  }

  // ─── Well-Known Discovery Endpoints ─────────────────────────────

  const wellKnownConfig: WellKnownConfig = {
    agentCard: config.agentCard,
    pricing: pricedRoutes.length > 0
      ? Object.fromEntries(pricedRoutes.map((r) => [r.route, { price: r.price, token: r.token }]))
      : undefined,
  };

  app.get('/.well-known/agent.json', handleAgentJson(wellKnownConfig));
  app.get('/.well-known/agent-card.json', handleAgentCardJson(wellKnownConfig));
  app.get('/.well-known/reputation', handleReputation(wellKnownConfig));

  // ─── Health Check ───────────────────────────────────────────────

  app.get('/health', handleHealth(config.agentCard, startTime));

  // ─── A2A Endpoint ───────────────────────────────────────────────

  const a2aHandler = new A2AHandler(config.taskManager);

  app.post('/a2a', async (c) => {
    try {
      const body = await c.req.json();
      const request = body as A2ARequest;

      // Validate JSON-RPC structure
      if (!request.jsonrpc || !request.method) {
        return c.json(
          {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: {
              code: -32600,
              message: 'Invalid JSON-RPC request',
            },
          },
          400
        );
      }

      const response = await a2aHandler.handleRequest(request);
      return c.json(response);
    } catch {
      return c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error',
            data: 'Invalid JSON',
          },
        },
        400
      );
    }
  });

  // ─── Agent Info Endpoint ────────────────────────────────────────

  app.get('/', (c) => {
    return c.json({
      name: config.agentCard.name,
      description: config.agentCard.description,
      version: config.agentCard.version,
      protocols: ['A2A', 'x402', 'ERC-8004'],
      endpoints: {
        a2a: '/a2a',
        agentCard: '/.well-known/agent.json',
        health: '/health',
        reputation: '/.well-known/reputation',
      },
      erc8004: config.agentCard.erc8004 ?? null,
      skills: config.agentCard.skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
    });
  });

  // ─── Start Server ───────────────────────────────────────────────

  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.hostname,
  });

  return server;
}
