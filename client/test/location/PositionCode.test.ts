import { describe, expect, it } from 'vitest';
import {
  parseCapturePosition,
  parseWorldPosition,
} from '../../src/location/positionCode';

const code =
  'setpos_exact -2093.968750 3117.968750 35.713593;setang_exact 7.128006 -19.183609 0.000000';
describe('CS2 raw position commands', () => {
  it('parses the supplied exact commands without changing signs or precision', () => {
    expect(parseCapturePosition(code)).toEqual({
      x: '-2093.968750',
      y: '3117.968750',
      z: '35.713593',
      pitch: '7.128006',
      yaw: '-19.183609',
      roll: '0.000000',
    });
    expect(parseWorldPosition(code)).toEqual({
      x: '-2093.968750',
      y: '3117.968750',
      z: '35.713593',
    });
  });
  it('accepts position-only calibration data but requires camera angles for a question', () => {
    expect(parseWorldPosition('setpos_exact -1 2 3')).toEqual({
      x: '-1',
      y: '2',
      z: '3',
    });
    expect(parseCapturePosition('setpos_exact -1 2 3')).toBeNull();
  });
  it('accepts ordinary commands, newlines, signed decimals and scientific notation', () => {
    expect(
      parseCapturePosition(' SETPOS +.5 -2. 1e2;\nSETANG -0.25 +90 0; ')
    ).toEqual({
      x: '+.5',
      y: '-2.',
      z: '1e2',
      pitch: '-0.25',
      yaw: '+90',
      roll: '0',
    });
  });
  it.each([
    '',
    'setpos_exact -1 2',
    'setpos_exact NaN 2 3',
    'setpos 1e309 2 3',
    'setpos 1 2 3oops',
    'setpos 1 2 3;setpos 4 5 6',
    'setpos 1 2 3;quit',
    'setpos 1 2 3;setang 0 90 Infinity',
  ])('rejects incomplete or ambiguous commands: %s', (text) => {
    expect(parseWorldPosition(text)).toBeNull();
    expect(parseCapturePosition(text)).toBeNull();
  });
});
