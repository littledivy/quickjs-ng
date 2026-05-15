export {};

const log = globalThis.print || console.log.bind(console);
const now = () => globalThis.performance.now();

function bench(name, fn, minMs = 350) {
  let iters = 1;
  let result = 0;

  for (;;) {
    const start = now();
    for (let i = 0; i < iters; i++) {
      result ^= fn(i);
    }
    const elapsed = now() - start;
    if (elapsed >= minMs) {
      log(`${name}: ${(elapsed / iters).toFixed(6)} ms/iter iters=${iters} result=${result >>> 0}`);
      return;
    }
    iters *= 2;
  }
}

function intArithmetic(seed) {
  let x = seed | 0;
  for (let i = 0; i < 5_000_000; i++) {
    x = (Math.imul(x ^ i, 1664525) + 1013904223) | 0;
  }
  return x;
}

function intSumLoop(seed) {
  let x = seed | 0;
  for (let i = 0; i < 5_000_000; i++) {
    x = (x + i) | 0;
  }
  return x;
}

function typedArrayScan(seed) {
  const bytes = typedArrayScan.bytes;
  let acc = seed | 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc + bytes[i] + ((acc << 5) ^ (acc >>> 2))) | 0;
  }
  return acc;
}
typedArrayScan.bytes = (() => {
  const bytes = new Uint8Array(1 << 20);
  let x = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
})();

function propertyLoad(seed) {
  const rows = propertyLoad.rows;
  let acc = seed | 0;
  for (let r = 0; r < 3500; r++) {
    for (let i = 0; i < rows.length; i++) {
      const o = rows[i];
      acc = (acc + o.a - o.b + o.c) | 0;
    }
  }
  return acc;
}
propertyLoad.rows = Array.from({ length: 512 }, (_, i) => ({
  a: i | 0,
  b: (i * 3) | 0,
  c: (i * 7) | 0,
}));

function closureCall(seed) {
  function mix(a, b) {
    return (Math.imul(a ^ b, 2654435761) + b) | 0;
  }

  let acc = seed | 0;
  for (let i = 0; i < 2_000_000; i++) {
    acc = mix(acc, i);
  }
  return acc;
}

function stringHash(seed) {
  const text = stringHash.text;
  let h = seed | 0;
  for (let r = 0; r < 180; r++) {
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(h ^ text.charCodeAt(i), 16777619)) | 0;
    }
  }
  return h;
}
stringHash.text = "QuickJS needs broad JIT coverage, not just benchmark-shaped native code.\n".repeat(2048);

bench("int-arithmetic", intArithmetic);
bench("int-sum-loop", intSumLoop);
bench("typed-array-scan", typedArrayScan);
bench("property-load", propertyLoad);
bench("closure-call", closureCall);
bench("string-hash", stringHash);
