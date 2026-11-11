// Risk register routes (modules/risks.ts). Registered from server.ts as its own plugin.
//
// ORG SCOPE: every collection route takes ?organizationId=. Customers' own organization is implicit
// and any other value is refused; staff must name the organization, except on /risks/portfolio,
// which is the cross-organization view and summarizes each organization separately.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal } from './context.js';
import * as risks from '../modules/risks.js';
import { CATEGORIES, IMPACT_DIMENSIONS, RATINGS } from '../modules/risk-scoring.js';

const level = z.number().int().min(1).max(5);
const range = z.object({ min: z.number().min(0), likely: z.number().min(0), max: z.number().min(0) });
const fair = z.object({ lef: range, lm: range }).nullable();
const dims = z.object(Object.fromEntries(IMPACT_DIMENSIONS.map((d) => [d, z.number().int().min(0).max(5).optional()]))).partial();
const orgQuery = z.object({ organizationId: z.string().uuid().optional() });

const riskFields = {
  title: z.string().trim().min(3).max(200),
  description: z.string().max(10_000).nullable(),
  cause: z.string().max(2000).nullable(),
  event: z.string().max(2000).nullable(),
  consequence: z.string().max(2000).nullable(),
  category: z.enum(CATEGORIES),
  threatSource: z.enum(['adversarial', 'accidental', 'structural', 'environmental']).nullable(),
  strategy: z.enum(['mitigate', 'transfer', 'avoid', 'accept']).nullable(),
  ownerId: z.string().uuid().nullable(),
  ownerName: z.string().max(200).nullable(),
  inherentLikelihood: level,
  inherentImpact: level,
  residualLikelihood: level,
  residualImpact: level,
  targetLikelihood: level.nullable(),
  targetImpact: level.nullable(),
  impactDimensions: dims,
  velocity: z.enum(['slow', 'moderate', 'rapid', 'immediate']).nullable(),
  fair,
  reviewFrequencyDays: z.number().int().min(1).max(1095).nullable(),
  tags: z.array(z.string().max(40)).max(20),
  note: z.string().max(2000),
};

const createBody = z
  .object(riskFields)
  .partial()
  .extend({ organizationId: z.string().uuid().optional(), title: riskFields.title, inherentLikelihood: level, inherentImpact: level })
  .strict();
const updateBody = z.object(riskFields).partial().strict();

const treatmentFields = {
  title: z.string().trim().min(2).max(200),
  description: z.string().max(5000).nullable(),
  ownerId: z.string().uuid().nullable(),
  status: z.enum(['planned', 'in_progress', 'done', 'cancelled']),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  costEstimate: z.number().min(0).nullable(),
  ticketId: z.string().uuid().nullable(),
};

export async function registerRiskRoutes(app: FastifyInstance): Promise<void> {
  // Cross-organization portfolio, worst organization first.
  app.get('/api/v1/risks/portfolio', async (req) => {
    const p = await requirePrincipal(req);
    return { data: await risks.portfolio(p) };
  });

  app.get('/api/v1/risks/settings', async (req) => {
    const p = await requirePrincipal(req);
    const q = orgQuery.parse(req.query);
    return risks.getSettings(p, q.organizationId);
  });

  app.put('/api/v1/risks/settings', async (req) => {
    const p = await requirePrincipal(req);
    const q = orgQuery.parse(req.query);
    const body = z
      .object({ appetiteScore: z.number().int().min(1).max(25), toleranceScore: z.number().int().min(1).max(25), maxAcceptanceDays: z.number().int().min(1).max(1095).optional() })
      .parse(req.body);
    return risks.putSettings(p, q.organizationId, body);
  });

  app.get('/api/v1/risks/finding-candidates', async (req) => {
    const p = await requirePrincipal(req);
    const q = orgQuery.parse(req.query);
    return { data: await risks.findingCandidates(p, q.organizationId) };
  });

  app.get('/api/v1/risks/export.csv', async (req, reply) => {
    const p = await requirePrincipal(req);
    const q = orgQuery.parse(req.query);
    const csv = await risks.exportCsv(p, q.organizationId);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="risk-register-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header('Cache-Control', 'no-store');
    return csv;
  });

  app.get('/api/v1/risks', async (req) => {
    const p = await requirePrincipal(req);
    const q = orgQuery
      .extend({
        status: z.enum(['identified', 'assessed', 'treating', 'monitoring', 'accepted', 'closed']).optional(),
        category: z.enum(CATEGORIES).optional(),
        rating: z.enum(RATINGS as [string, ...string[]]).optional(),
        q: z.string().max(200).optional(),
        ownerId: z.string().uuid().optional(),
        includeClosed: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    return { data: await risks.listRisks(p, q.organizationId, { ...q, includeClosed: q.includeClosed === 'true' }) };
  });

  app.post('/api/v1/risks', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = createBody.parse(req.body);
    const r = await risks.createRisk(p, body as risks.CreateRiskInput);
    reply.status(201);
    return r;
  });

  app.post('/api/v1/risks/from-finding/:findingId', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { findingId } = z.object({ findingId: z.string().uuid() }).parse(req.params);
    const r = await risks.createFromFinding(p, findingId);
    reply.status(201);
    return r;
  });

  app.get('/api/v1/risks/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return risks.getRisk(p, id);
  });

  app.patch('/api/v1/risks/:id', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return risks.updateRisk(p, id, updateBody.parse(req.body) as risks.RiskInput);
  });

  app.post('/api/v1/risks/:id/review', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
    return risks.markReviewed(p, id, body.note);
  });

  app.post('/api/v1/risks/:id/transition', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ to: z.enum(['identified', 'assessed', 'treating', 'monitoring', 'closed']), note: z.string().max(2000).optional() })
      .parse(req.body);
    return risks.transitionRisk(p, id, body.to, body.note);
  });

  app.post('/api/v1/risks/:id/acceptance', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ justification: z.string().trim().min(10).max(5000), expiresAt: z.string().datetime({ offset: true }) }).parse(req.body);
    return risks.requestAcceptance(p, id, body);
  });

  app.post('/api/v1/risks/:id/acceptance/decide', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ approve: z.boolean(), note: z.string().max(2000).optional() }).parse(req.body);
    return risks.decideAcceptance(p, id, body.approve, body.note);
  });

  app.post('/api/v1/risks/:id/treatments', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object(treatmentFields).partial().extend({ title: treatmentFields.title }).strict().parse(req.body);
    const t = await risks.addTreatment(p, id, body);
    reply.status(201);
    return t;
  });

  app.patch('/api/v1/risks/:id/treatments/:treatmentId', async (req) => {
    const p = await requirePrincipal(req);
    const { id, treatmentId } = z.object({ id: z.string().uuid(), treatmentId: z.string().uuid() }).parse(req.params);
    return risks.updateTreatment(p, id, treatmentId, z.object(treatmentFields).partial().strict().parse(req.body));
  });

  app.post('/api/v1/risks/:id/links', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ kind: z.enum(['control', 'finding', 'ticket', 'problem', 'change', 'service']), ref: z.string().trim().min(1).max(64) })
      .parse(req.body);
    const l = await risks.addLink(p, id, body.kind, body.ref);
    reply.status(201);
    return l;
  });

  app.delete('/api/v1/risks/:id/links/:linkId', async (req) => {
    const p = await requirePrincipal(req);
    const { id, linkId } = z.object({ id: z.string().uuid(), linkId: z.string().uuid() }).parse(req.params);
    return risks.removeLink(p, id, linkId);
  });
}
