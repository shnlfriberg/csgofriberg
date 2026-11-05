export const API_TOKEN_SCOPES = ['players:read', 'changes:submit', 'players:write'] as const;
export type ApiTokenScope = typeof API_TOKEN_SCOPES[number];
export const DEFAULT_API_TOKEN_SCOPES: ApiTokenScope[] = ['players:read', 'changes:submit'];
export function readTokenScopes(value: string | null): ApiTokenScope[] {
  if (value == null) return [...API_TOKEN_SCOPES];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? API_TOKEN_SCOPES.filter(scope => parsed.includes(scope)) : [];
  } catch { return []; }
}
