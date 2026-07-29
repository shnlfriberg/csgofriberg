const DOMAIN = Uint8Array.from([
  0x63, 0x73, 0x67, 0x6f, 0x66, 0x72, 0x69, 0x62, 0x65, 0x72, 0x67,
  0x2d, 0x70, 0x6f, 0x77, 0x2d, 0x76, 0x31, 0x00,
]);

const SHA256_INITIAL = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

class Sha256 {
  private readonly padded = new Uint8Array(128);
  private readonly words = new Uint32Array(64);
  private readonly state = new Uint32Array(8);

  digest(input: Uint8Array, output: Uint8Array): void {
    const blockLength = Math.ceil((input.length + 9) / 64) * 64;
    if (blockLength > this.padded.length || output.length < 32) throw new Error('POW_HASH_INPUT_INVALID');
    this.padded.fill(0, 0, blockLength);
    this.padded.set(input);
    this.padded[input.length] = 0x80;
    const bitLength = input.length * 8;
    this.padded[blockLength - 4] = bitLength >>> 24;
    this.padded[blockLength - 3] = bitLength >>> 16;
    this.padded[blockLength - 2] = bitLength >>> 8;
    this.padded[blockLength - 1] = bitLength;
    this.state.set(SHA256_INITIAL);

    for (let offset = 0; offset < blockLength; offset += 64) {
      for (let index = 0; index < 16; index++) {
        const position = offset + index * 4;
        this.words[index] = (
          (this.padded[position] << 24) |
          (this.padded[position + 1] << 16) |
          (this.padded[position + 2] << 8) |
          this.padded[position + 3]
        ) >>> 0;
      }
      for (let index = 16; index < 64; index++) {
        const previous15 = this.words[index - 15];
        const previous2 = this.words[index - 2];
        const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
        const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
        this.words[index] = (this.words[index - 16] + sigma0 + this.words[index - 7] + sigma1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = this.state;
      for (let index = 0; index < 64; index++) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + this.words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      this.state[0] = (this.state[0] + a) >>> 0;
      this.state[1] = (this.state[1] + b) >>> 0;
      this.state[2] = (this.state[2] + c) >>> 0;
      this.state[3] = (this.state[3] + d) >>> 0;
      this.state[4] = (this.state[4] + e) >>> 0;
      this.state[5] = (this.state[5] + f) >>> 0;
      this.state[6] = (this.state[6] + g) >>> 0;
      this.state[7] = (this.state[7] + h) >>> 0;
    }

    for (let index = 0; index < 8; index++) {
      const value = this.state[index];
      output[index * 4] = value >>> 24;
      output[index * 4 + 1] = value >>> 16;
      output[index * 4 + 2] = value >>> 8;
      output[index * 4 + 3] = value;
    }
  }
}

function uint64ToDecimal(low: number, high: number): string {
  if (high <= 0x1fffff) return String(high * 0x100000000 + low);
  const base = 10_000_000;
  const digits = [high % base, Math.floor(high / base)];
  for (let pass = 0; pass < 2; pass++) {
    let carry = 0;
    for (let index = 0; index < digits.length; index++) {
      const value = digits[index] * 65_536 + carry;
      digits[index] = value % base;
      carry = Math.floor(value / base);
    }
    if (carry) digits.push(carry);
  }
  let carry = low;
  for (let index = 0; carry && index < digits.length; index++) {
    const value = digits[index] + carry;
    digits[index] = value % base;
    carry = Math.floor(value / base);
  }
  if (carry) digits.push(carry);
  return digits.pop() + digits.reverse().map((value) => String(value).padStart(7, '0')).join('');
}

function hasLeadingZeroBits(digest: Uint8Array, difficulty: number): boolean {
  const wholeBytes = Math.floor(difficulty / 8);
  for (let index = 0; index < wholeBytes; index++) if (digest[index] !== 0) return false;
  const remaining = difficulty & 7;
  return remaining === 0 || (digest[wholeBytes] & (0xff << (8 - remaining))) === 0;
}

export class JsPowSolver {
  private readonly sha256 = new Sha256();
  private readonly firstInput = new Uint8Array(DOMAIN.length + 32 + 8);
  private readonly firstDigest = new Uint8Array(32);
  private readonly secondInput = new Uint8Array(DOMAIN.length + 32);
  private readonly finalDigest = new Uint8Array(32);
  private low = 0;
  private high = 0;
  private exhausted = false;

  constructor(challenge: Uint8Array, private readonly difficulty: number) {
    if (challenge.length !== 32 || !Number.isInteger(difficulty) || difficulty < 16 || difficulty > 24) {
      throw new Error('POW_CHALLENGE_INVALID');
    }
    this.firstInput.set(DOMAIN);
    this.firstInput.set(challenge, DOMAIN.length);
    this.secondInput.set(DOMAIN);
  }

  solveChunk(count: number): string | null {
    if (this.exhausted) throw new Error('POW_NOT_FOUND');
    const nonceOffset = DOMAIN.length + 32;
    for (let attempt = 0; attempt < count; attempt++) {
      this.firstInput[nonceOffset] = this.low;
      this.firstInput[nonceOffset + 1] = this.low >>> 8;
      this.firstInput[nonceOffset + 2] = this.low >>> 16;
      this.firstInput[nonceOffset + 3] = this.low >>> 24;
      this.firstInput[nonceOffset + 4] = this.high;
      this.firstInput[nonceOffset + 5] = this.high >>> 8;
      this.firstInput[nonceOffset + 6] = this.high >>> 16;
      this.firstInput[nonceOffset + 7] = this.high >>> 24;
      this.sha256.digest(this.firstInput, this.firstDigest);
      for (let index = 0; index < 32; index++) {
        this.secondInput[DOMAIN.length + index] = (
          this.firstDigest[(index + 11) & 31] ^
          this.firstDigest[index] ^
          ((index * 29 + 0x5d) & 0xff)
        );
      }
      this.sha256.digest(this.secondInput, this.finalDigest);
      if (hasLeadingZeroBits(this.finalDigest, this.difficulty)) {
        return uint64ToDecimal(this.low, this.high);
      }
      this.low = (this.low + 1) >>> 0;
      if (this.low === 0) {
        this.high = (this.high + 1) >>> 0;
        if (this.high === 0) this.exhausted = true;
      }
    }
    return null;
  }
}
