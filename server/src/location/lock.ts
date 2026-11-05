import { withKeyLock as sharedLock } from '../services/keyLock';

// Catalog changes and eight simultaneous room submissions can briefly contend.
// Keep the shared distributed lease protocol, with a bounded wait for this mode.
export async function withKeyLock<T>(
  key: string,
  action: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sharedLock(key, action);
    } catch (error) {
      if (
        !(error instanceof Error && error.message === 'RESOURCE_BUSY') ||
        attempt >= 3
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
}
