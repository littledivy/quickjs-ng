import { spawnSync } from "node:child_process";

const qjs = process.env.QJS || "build-jit/qjs";
const node = process.env.NODE || process.execPath;

function run(label, command, args, env = {}) {
  console.log(`\n## ${label}`);
  const res = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  if (res.status !== 0) {
    process.exitCode = res.status || 1;
  }
}

run("QuickJS microbenchmarks", qjs, ["benchmarks/micro_jit.js"]);
run("Node/V8 microbenchmarks", node, ["--no-warnings", "benchmarks/micro_jit.js"]);
run("QuickJS encoding JIT benchmark", qjs, ["benchmarks/encoding_jit.js"]);
run("Node/V8 encoding benchmark", node, ["--no-warnings", "benchmarks/encoding_jit.js"]);
run("Node HTTP server throughput (keep-alive, 1 conn)", node, ["benchmarks/http_server_throughput.mjs", "--server", "node"], { CONNECTIONS: "1" });
run("Node HTTP server throughput (close)", node, ["benchmarks/http_server_throughput.mjs", "--server", "node", "--keep-alive", "0"], { REQUESTS: "5000" });
run("QuickJS HTTP server throughput (keep-alive, 1 conn)", node, ["benchmarks/http_server_throughput.mjs", "--server", "qjs", "--qjs", qjs], { CONNECTIONS: "1" });
run("QuickJS HTTP server throughput (close)", node, ["benchmarks/http_server_throughput.mjs", "--server", "qjs", "--qjs", qjs, "--keep-alive", "0"], { REQUESTS: "5000" });
run("Real 200k-line startup", node, ["benchmarks/startup_real_200k.mjs", "--qjs", qjs, "--node", node]);
