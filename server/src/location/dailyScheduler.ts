import { ensureDaily } from './games';
import { dayWindow } from './rules';

const RETRY_DELAY_MS = 60_000;

// Every app instance runs this worker. ensureDaily's distributed lock and unique
// date key keep the same three decks fixed across workers and player requests.
export function startLocationDailyScheduler(): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  let lastError = '';

  const run = async (): Promise<void> => {
    const now = Date.now();
    const { date } = dayWindow(now);
    let succeeded = false;
    try {
      await ensureDaily(now);
      succeeded = true;
      lastError = '';
      console.log(`[location:daily] ${date} 题单已就绪（Asia/Shanghai）`);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const signature = `${date}:${code}`;
      if (lastError !== signature) {
        lastError = signature;
        console.error(`[location:daily] ${date} 生成失败，将自动重试`, error);
      }
    } finally {
      if (!stopped) {
        const current = Date.now();
        const window = dayWindow(current);
        // A slow generation can cross midnight; immediately catch up in that case.
        const delay = succeeded
          ? window.date === date ? window.nextRefreshAt - current : 0
          : Math.min(RETRY_DELAY_MS, window.nextRefreshAt - current);
        timer = setTimeout(() => {
          pending = run();
        }, Math.max(1, delay));
        timer.unref?.();
      }
    }
  };

  // Covers a missed midnight during downtime and a newly installed question bank.
  pending = run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
