import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const packageSpec = "typescript@6.0.3";
const sourcePath = "package/lib/typescript.js";
const outDir = resolve("benchmarks/corpus");
const outFile = join(outDir, "typescript-6.0.3.js");
const manifestFile = join(outDir, "typescript-6.0.3.manifest.json");

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

if (existsSync(outFile)) {
  const lines = readFileSync(outFile, "utf8").split("\n").length;
  console.log(`${outFile} already exists (${lines} lines)`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const temp = join(tmpdir(), `qjs-real-startup-${process.pid}`);
rmSync(temp, { recursive: true, force: true });
mkdirSync(temp, { recursive: true });

try {
  const tarballName = run("npm", ["pack", packageSpec, "--silent"], { cwd: temp });
  run("tar", ["-xzf", tarballName], { cwd: temp });

  const src = join(temp, sourcePath);
  copyFileSync(src, outFile);

  const text = readFileSync(outFile, "utf8");
  const lines = text.split("\n").length;
  if (lines < 200_000) {
    throw new Error(`${basename(outFile)} has ${lines} lines, expected at least 200000`);
  }

  writeFileSync(manifestFile, `${JSON.stringify({
    package: packageSpec,
    source: sourcePath,
    output: outFile,
    lines,
    note: "Real published TypeScript compiler JavaScript, used as a startup parse+execute corpus.",
  }, null, 2)}\n`);

  console.log(`wrote ${outFile} (${lines} lines)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
