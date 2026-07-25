declare global {
  interface Window {
    umami?: {
      track: (eventName: string, data?: Record<string, string | number | boolean>) => void;
    };
  }
}

export function trackUmamiEvent(
  eventName: string,
  data?: Record<string, string | number | boolean>
): void {
  window.setTimeout(() => {
    try {
      window.umami?.track(eventName, data);
    } catch {
      // Analytics must never affect the product interaction it observes.
    }
  }, 0);
}
