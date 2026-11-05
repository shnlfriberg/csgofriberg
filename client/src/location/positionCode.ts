export interface WorldPosition {
  x: string;
  y: string;
  z: string;
}
export interface CapturePosition extends WorldPosition {
  pitch: string;
  yaw: string;
  roll: string;
}

const number = '([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)';
const positionPattern = new RegExp(
  `^setpos(?:_exact)?\\s+${number}\\s+${number}\\s+${number}$`,
  'i'
);
const anglePattern = new RegExp(
  `^setang(?:_exact)?\\s+${number}\\s+${number}\\s+${number}$`,
  'i'
);

// Parse data only. Pasted console commands are never executed.
function readCommands(text: string) {
  let position: string[] | null = null;
  let angles: string[] | null = null;
  for (const command of text
    .split(/[;\r\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const p = command.match(positionPattern);
    const a = command.match(anglePattern);
    if (p && !position) position = p.slice(1);
    else if (a && !angles) angles = a.slice(1);
    else return null;
  }
  if (
    !position ||
    [...position, ...(angles || [])].some(
      (value) => !Number.isFinite(Number(value))
    )
  )
    return null;
  return { position, angles };
}

export function parseWorldPosition(text: string): WorldPosition | null {
  const parsed = readCommands(text);
  if (!parsed) return null;
  const [x, y, z] = parsed.position;
  return { x, y, z };
}

export function parseCapturePosition(text: string): CapturePosition | null {
  const parsed = readCommands(text);
  if (!parsed?.angles) return null;
  const [x, y, z] = parsed.position;
  const [pitch, yaw, roll] = parsed.angles;
  return { x, y, z, pitch, yaw, roll };
}
