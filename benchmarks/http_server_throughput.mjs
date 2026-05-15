import http from "node:http";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1] || "1");
}

const serverKind = args.get("--server") || "node";
const qjs = args.get("--qjs") || "build-jit/qjs";
const keepAlive = args.get("--keep-alive") !== "0";
const connections = Number(process.env.CONNECTIONS || 64);
const requests = Number(process.env.REQUESTS || (keepAlive ? 50_000 : 5_000));
const payload = Buffer.from("quickjs-ng benchmark response\n");

function requestOnce(port, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1",
      port,
      path: "/checksum?x=123",
      agent,
    }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
  });
}

async function worker(port, count) {
  const agent = new http.Agent({ keepAlive, maxSockets: 1 });
  for (let i = 0; i < count; i++) {
    await requestOnce(port, agent);
  }
  agent.destroy();
}

async function startNodeServer() {
  let checksum = 0;
  const server = http.createServer((req, res) => {
    checksum = (checksum + req.url.length + payload.length) | 0;
    res.writeHead(200, {
      "content-type": "text/plain",
      "content-length": payload.length,
      "connection": keepAlive ? "keep-alive" : "close",
    });
    res.end(payload);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    checksum: () => checksum >>> 0,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startQjsServer() {
  const child = spawn(qjs, [
    "benchmarks/qjs_http_server.js",
    String(requests),
    keepAlive ? "keepalive" : "close",
  ], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  let output = "";
  let doneLine = "";
  const exitPromise = new Promise((resolve, reject) => {
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`qjs server exited with ${code}`)));
  });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    const done = output.match(/^DONE .+$/m);
    if (done) doneLine = done[0];
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for qjs server port")), 5000);
    child.stdout.on("data", () => {
      const match = output.match(/^PORT ([0-9]+)$/m);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`qjs server exited before benchmark: ${code}`));
    });
  });

  return {
    port,
    checksum: () => doneLine,
    close: () => exitPromise,
  };
}

async function main() {
  const server = serverKind === "qjs" ? await startQjsServer() : await startNodeServer();
  const port = server.port;

  const started = performance.now();
  const base = Math.floor(requests / connections);
  const extra = requests % connections;
  await Promise.all(Array.from({ length: connections }, (_, i) =>
    worker(port, base + (i < extra ? 1 : 0))));
  const elapsedMs = performance.now() - started;

  await server.close();

  const rps = requests / (elapsedMs / 1000);
  const label = serverKind === "node" ? `node-${keepAlive ? "keepalive" : "close"}` : serverKind;
  console.log(`http-server-throughput-${label}: ${rps.toFixed(0)} req/s requests=${requests} connections=${connections} ms=${elapsedMs.toFixed(3)} checksum=${server.checksum()}`);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
