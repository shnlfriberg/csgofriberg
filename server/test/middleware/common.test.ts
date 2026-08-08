import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { validateBody, validateParams, validateQuery } from '../../src/middleware/common';

function responseMock() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { status } as unknown as Response, status, json };
}

describe('request validation middleware', () => {
  it.each([
    ['body', validateBody, { count: '2' }],
    ['query', validateQuery, { count: '2' }],
    ['params', validateParams, { count: '2' }],
  ] as const)('parses and replaces %s data', (_part, middleware, input) => {
    const req = { body: {}, query: {}, params: {}, [_part]: input } as unknown as Request;
    const next = vi.fn() as NextFunction;
    const { response } = responseMock();

    middleware(z.object({ count: z.coerce.number().int().positive() }))(req, response, next);

    expect(req[_part]).toEqual({ count: 2 });
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects invalid input before the route handler', () => {
    const req = { body: { id: 0 }, query: {}, params: {} } as unknown as Request;
    const next = vi.fn() as NextFunction;
    const { response, status, json } = responseMock();

    validateBody(z.object({ id: z.number().int().positive() }))(req, response, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ code: 'VALIDATION_FAILED' });
    expect(next).not.toHaveBeenCalled();
  });
});
