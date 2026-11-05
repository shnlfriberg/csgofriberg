// Shared limits keep the batch editor and the protected upload route consistent.
export const SUBMISSION_LIMITS = {
  batchImages: 30,
  batchBytes: 256 * 1024 * 1024,
  points: 100,
  pending: 100,
  identityPerHour: 60,
  ipPerHour: 120,
} as const;
