import { BoType } from '../services/roomStore';

export function winsNeeded(bo: BoType): number {
  return Math.ceil(bo / 2);
}
