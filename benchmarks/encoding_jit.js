export {};

const log = globalThis.print || console.log.bind(console);
const now = () => globalThis.performance.now();

function pack24(a, b, c) {
  return (a << 16) | (b << 8) | c;
}

function b64QuadChecksum(a, b, c) {
  const x = (a << 16) | (b << 8) | c;
  return ((x >> 18) & 63) + ((x >> 12) & 63) + ((x >> 6) & 63) + (x & 63);
}

function makeInput(size) {
  const bytes = new Uint8Array(size);
  let x = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) | 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
}

function encodeChecksum(bytes, rounds) {
  let checksum = 0;
  let emitted = 0;

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i + 2 < bytes.length; i += 3) {
      checksum = (checksum + b64QuadChecksum(bytes[i], bytes[i + 1], bytes[i + 2])) | 0;
      emitted += 4;
    }
  }

  return (checksum ^ emitted) >>> 0;
}

function bench(name, fn) {
  const start = now();
  const result = fn();
  const elapsedMs = now() - start;
  log(`${name}: ${elapsedMs.toFixed(3)} ms result=${result}`);
}

const size = 384 * 1024;
const rounds = 60;
const bytes = makeInput(size);

bench("encoding-checksum", () => encodeChecksum(bytes, rounds));
