/**
 * Admin API key management routes — extracted from index.js (#744).
 *
 * Handles create / list / revoke / rotate / rate-tier-update for platform API keys.
 * All routes require the master key; the router itself must be mounted behind
 * the appropriate rate limiter and auth middleware in the app wiring (index.js).
 */

import { Router } from 'express';
import { apiKeyCreateSchema, apiKeyRateTierUpdateSchema, formatZodErrors } from '../schemas.js';

/**
 * @param {{
 *   apiKeyRepository: {
 *     create(opts: object): { rawKey: string, key: object },
 *     list(): object[],
 *     getById(id: string): object | undefined,
 *     revoke(id: string): void,
 *     rotate(id: string): { rawKey: string, key: object } | null,
 *     setRateTier(id: string, tier: string): object,
 *   },
 *   requireMasterKey: import('express').RequestHandler,
 *   idempotencyMiddleware: import('express').RequestHandler,
 *   rateLimiter: import('express').RequestHandler,
 *   recordAuditEntry: (req: import('express').Request, entry: object) => void,
 * }} deps
 * @returns {import('express').Router}
 */
export function createAdminKeyRoutes(deps) {
  const { apiKeyRepository, requireMasterKey, idempotencyMiddleware, rateLimiter, recordAuditEntry } =
    deps;

  const router = Router();

  // POST /admin/api-keys — provision a new API key
  router.post(
    '/admin/api-keys',
    rateLimiter,
    idempotencyMiddleware,
    requireMasterKey,
    (req, res) => {
      const result = apiKeyCreateSchema.safeParse(req.body ?? {});
      if (!result.success) {
        return res.status(400).json({
          error: 'Invalid API key payload',
          code: 'VALIDATION_ERROR',
          details: formatZodErrors(result.error),
        });
      }

      const created = apiKeyRepository.create({
        label: result.data.label ?? '',
        expiresAt: result.data.expiresAt ?? null,
        orgId: result.data.orgId ?? null,
        scopes: result.data.scopes ?? undefined,
        rateTier: result.data.rateTier ?? undefined,
      });

      recordAuditEntry(req, {
        action: 'create',
        entity: 'apiKey',
        entityId: created.key.id,
        diff: { after: created.key },
      });

      return res.status(201).json({ key: created.rawKey, metadata: created.key });
    },
  );

  // GET /admin/api-keys — list all API keys
  router.get('/admin/api-keys', rateLimiter, requireMasterKey, (_req, res) => {
    return res.json({ data: apiKeyRepository.list() });
  });

  // DELETE /admin/api-keys/:id — revoke an API key
  router.delete('/admin/api-keys/:id', rateLimiter, requireMasterKey, (req, res) => {
    const before = apiKeyRepository.getById(req.params.id);
    if (!before) {
      return res.status(404).json({ error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
    }

    apiKeyRepository.revoke(req.params.id);
    recordAuditEntry(req, {
      action: 'revoke',
      entity: 'apiKey',
      entityId: req.params.id,
      diff: { before },
    });

    return res.status(204).end();
  });

  // PUT /admin/api-keys/:id/rotate — issue a replacement key
  router.put(
    '/admin/api-keys/:id/rotate',
    rateLimiter,
    idempotencyMiddleware,
    requireMasterKey,
    (req, res) => {
      const rotated = apiKeyRepository.rotate(req.params.id);
      if (!rotated) {
        return res
          .status(404)
          .json({ error: 'API key not found or already revoked', code: 'API_KEY_NOT_FOUND' });
      }

      recordAuditEntry(req, {
        action: 'rotate',
        entity: 'apiKey',
        entityId: req.params.id,
        diff: { newKeyId: rotated.key.id },
      });

      return res.status(200).json({ key: rotated.rawKey, metadata: rotated.key });
    },
  );

  // PUT /admin/api-keys/:id/rate-tier — change the rate tier of an existing key
  router.put(
    '/admin/api-keys/:id/rate-tier',
    rateLimiter,
    idempotencyMiddleware,
    requireMasterKey,
    (req, res) => {
      const before = apiKeyRepository.getById(req.params.id);
      if (!before) {
        return res.status(404).json({ error: 'API key not found', code: 'API_KEY_NOT_FOUND' });
      }

      const result = apiKeyRateTierUpdateSchema.safeParse(req.body ?? {});
      if (!result.success) {
        return res.status(400).json({
          error: 'Invalid rate tier payload',
          code: 'VALIDATION_ERROR',
          details: formatZodErrors(result.error),
        });
      }

      const updated = apiKeyRepository.setRateTier(req.params.id, result.data.rateTier);

      recordAuditEntry(req, {
        action: 'update',
        entity: 'apiKey',
        entityId: req.params.id,
        diff: {
          before: { rateTier: /** @type {any} */ (before).rateTier },
          after: { rateTier: /** @type {any} */ (updated).rateTier },
        },
      });

      return res.status(200).json({ metadata: updated });
    },
  );

  return router;
}
