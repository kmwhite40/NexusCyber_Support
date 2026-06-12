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
  validation: (detail?: string) => new ApiError(422, 'Unprocessable Entity', detail, 'validation'),
  badRequest: (detail?: string) => new ApiError(400, 'Bad Request', detail, 'bad_request'),
};
