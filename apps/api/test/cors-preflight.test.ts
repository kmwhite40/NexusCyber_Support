import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { corsOptions } from '../src/http/cors.js';

// The web app and the API are separate origins in every environment, so every PUT, PATCH and
// DELETE from the browser is preceded by a CORS preflight. @fastify/cors v10+ answers that
// preflight with only GET,HEAD,POST unless methods are listed. The Fastify 5 upgrade pulled in
// v11 and silently broke every browser write that was not a POST (CAB board save, platform user
// access, org edits). Server-side tests call handlers directly and never see a preflight.
const ORIGIN = 'http://localhost:3000';

async function preflight(method: string) {
  const app = Fastify();
  await app.register(cors, corsOptions([ORIGIN]));
  app.all('/x', async () => ({}));
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/x',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  await app.close();
  return res;
}

describe('corsOptions', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('allows a browser %s from the web origin', async (method) => {
    const res = await preflight(method);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(String(res.headers['access-control-allow-methods']).split(/,\s*/)).toContain(method);
  });

  it('still refuses an origin that is not the web app', async () => {
    const app = Fastify();
    await app.register(cors, corsOptions([ORIGIN]));
    app.all('/x', async () => ({}));
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/x',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
    });
    await app.close();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
