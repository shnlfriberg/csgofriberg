import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

/**
 * API 错误只携带机器可读的 code(以及 HTTP 状态码),
 * 具体文案由前端翻译。
 */
export class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

function validateRequestPart(schema: ZodSchema, part: 'body' | 'query' | 'params') {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      return res.status(400).json({ code: 'VALIDATION_FAILED' });
    }
    req[part] = result.data;
    next();
  };
}

export function validateBody(schema: ZodSchema) {
  return validateRequestPart(schema, 'body');
}

export function validateQuery(schema: ZodSchema) {
  return validateRequestPart(schema, 'query');
}

export function validateParams(schema: ZodSchema) {
  return validateRequestPart(schema, 'params');
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (
    err instanceof Error &&
    'type' in err &&
    ['stream.not.readable', 'request.aborted'].includes(String(err.type))
  ) {
    return res.status(400).json({ code: 'INVALID_REQUEST_BODY' });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ code: err.code });
  }
  if (err instanceof Error && err.message === 'REDIS_UNAVAILABLE') {
    return res.status(503).json({ code: 'REDIS_UNAVAILABLE' });
  }
  if (err instanceof Error && err.message === 'PASSWORD_SERVICE_BUSY') {
    return res.status(503).json({ code: 'AUTH_BUSY' });
  }
  if (err instanceof Error && 'type' in err && err.type === 'entity.too.large') {
    const bodyError = err as Error & { limit?: number; length?: number };
    return res.status(413).json({
      code: 'PAYLOAD_TOO_LARGE',
      ...(Number.isFinite(bodyError.limit) ? { maxBytes: bodyError.limit } : {}),
      ...(Number.isFinite(bodyError.length) ? { receivedBytes: bodyError.length } : {}),
    });
  }
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    return res.status(400).json({ code: 'INVALID_REQUEST_BODY' });
  }
  if (err instanceof Error && err.message.includes('Timeout acquiring a connection')) {
    return res.status(503).json({ code: 'DATABASE_BUSY' });
  }
  console.error(err);
  res.status(500).json({ code: 'INTERNAL_ERROR' });
}

/** 包装 async 路由,把 rejection 交给 errorHandler */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
