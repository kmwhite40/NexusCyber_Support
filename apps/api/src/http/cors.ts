import type { FastifyCorsOptions } from '@fastify/cors';

// The web app and API are separate origins, so every non-POST browser write is preflighted.
// @fastify/cors v10+ defaults `methods` to GET,HEAD,POST; list them explicitly or the browser
// refuses every PUT, PATCH and DELETE before it reaches a route.
export function corsOptions(origin: string[]): FastifyCorsOptions {
  return {
    origin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  };
}
