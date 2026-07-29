import { JsPowSolver } from './powJs';

interface SolveMessage {
  challenge: string;
  difficulty: number;
}

const CHUNK_SIZE = 2_000;

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function solve(message: SolveMessage): Promise<string> {
  const solver = new JsPowSolver(decodeBase64Url(message.challenge), message.difficulty);
  while (true) {
    const nonce = solver.solveChunk(CHUNK_SIZE);
    if (nonce !== null) return nonce;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

self.onmessage = (event: MessageEvent<SolveMessage>) => {
  void solve(event.data).then(
    (nonce) => self.postMessage({ nonce }),
    (error) => self.postMessage({ error: error instanceof Error ? error.message : 'POW_FAILED' })
  );
};

export {};
