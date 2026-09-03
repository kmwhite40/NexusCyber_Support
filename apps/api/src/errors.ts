// RFC 7807-style problem errors (docs/nexus/09 §T.1).

export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail?: string,
    public code?: string,
  ) {
    super(detail ?? title);
  }
}

export const Errors = {
  unauthorized: (detail?: string) => new ApiError(401, 'Unauthorized', detail, 'unauthorized'),
  stepUpRequired: (detail?: string) =>
    new ApiError(401, 'Step-up authentication required', detail, 'step_up_required'),
  forbidden: (detail?: string) => new ApiError(403, 'Forbidden', detail, 'forbidden'),
  notFound: (detail?: string) => new ApiError(404, 'Not Found', detail, 'not_found'),
  conflict: (detail?: string) => new ApiError(409, 'Conflict', detail, 'conflict'),
  // Distinct from `conflict` on purpose: a caller-supplied precondition (an etag, a plan
  // fingerprint) no longer matches current state, so the request must be rebuilt from a fresh
  // read rather than retried. Provisioning's preview/execute binding depends on the UI being
  // able to tell this apart from "a run is already in progress", which is also a 409.
  preconditionFailed: (detail?: string) =>
    new ApiError(412, 'Precondition Failed', detail, 'precondition_failed'),
  validation: (detail?: string) => new ApiError(422, 'Unprocessable Entity', detail, 'validation'),
  badRequest: (detail?: string) => new ApiError(400, 'Bad Request', detail, 'bad_request'),
  // An upstream (Microsoft Graph, a customer tenant) refused or failed. Distinct from a 500:
  // nothing here is broken, and the operator can usually fix it — but only if they can read
  // what the upstream actually said, so this one is meant to carry the message through.
  badGateway: (detail?: string) => new ApiError(502, 'Bad Gateway', detail, 'upstream_error'),
};
