import { chmodSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { tmpdir } from "node:os";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const qjs = args.get("--qjs") || "build-jit/qjs";
const node = args.get("--node") || process.execPath;
const runs = Number(args.get("--runs") || 7);
const corpus = args.get("--corpus") || "benchmarks/corpus/typescript-6.0.3.js";

if (!existsSync(corpus)) {
  const res = spawnSync(process.execPath, ["benchmarks/prepare_real_startup_corpus.mjs"], { stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status || 1);
}

function measure(label, command, commandArgs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const res = spawnSync(command, commandArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, QJS_JIT_TRACE: "0" },
    });
    const elapsed = performance.now() - started;
    if (res.status !== 0) {
      throw new Error(`${label} failed with status ${res.status}\n${res.stderr.toString()}`);
    }
    times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const min = times[0];
  const max = times[times.length - 1];
  console.log(`${label}: median=${median.toFixed(3)} ms min=${min.toFixed(3)} max=${max.toFixed(3)} runs=${runs}`);
}

function compileQjsExecutable() {
  const out = join(tmpdir(), `qjs-real-200k-${process.pid}`);
  rmSync(out, { force: true });
  const started = performance.now();
  const res = spawnSync(qjs, ["--compile", corpus, "--out", out], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const elapsed = performance.now() - started;
  if (res.status !== 0) {
    throw new Error(`qjs --compile failed with status ${res.status}\n${res.stderr.toString()}`);
  }
  chmodSync(out, 0o755);
  console.log(`startup-real-200k-qjs-compile: ${elapsed.toFixed(3)} ms`);
  return out;
}

measure("startup-real-200k-qjs", qjs, [corpus]);
const qjsExecutable = compileQjsExecutable();
try {
  measure("startup-real-200k-qjs-compiled", qjsExecutable, []);
} finally {
  rmSync(qjsExecutable, { force: true });
}
measure("startup-real-200k-node", node, ["--no-warnings", corpus]);
