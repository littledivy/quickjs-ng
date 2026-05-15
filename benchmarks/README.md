# QuickJS-NG JIT Benchmarks

This directory is for engine-level performance checks across three scopes:

- `micro_jit.js`: tiny hot-loop kernels that expose broad JIT coverage gaps.
- `encoding_jit.js`: the current specialized encoding checksum fast path.
- `http_server_throughput.mjs`: HTTP throughput harness for Node and QuickJS.
- `qjs_http_server.js`: simple QuickJS HTTP/1.1 server using the experimental `qjs:os` TCP listen/accept bindings.
- `startup_real_200k.mjs`: process startup plus parse/execute time for a real 200k-line JavaScript corpus, plus QuickJS precompiled-executable startup.

## Commands

Build QuickJS with the experimental JIT:

```sh
cmake -S . -B build-jit -DCMAKE_BUILD_TYPE=Release -DQJS_ENABLE_JIT=ON
cmake --build build-jit -j8
```

Run the full local suite:

```sh
node benchmarks/run_benchmarks.mjs
```

Run individual comparisons:

```sh
build-jit/qjs benchmarks/micro_jit.js
node --no-warnings benchmarks/micro_jit.js

build-jit/qjs benchmarks/encoding_jit.js
node --no-warnings benchmarks/encoding_jit.js

node benchmarks/http_server_throughput.mjs --server node
CONNECTIONS=1 node benchmarks/http_server_throughput.mjs --server node
CONNECTIONS=1 node benchmarks/http_server_throughput.mjs --server qjs --qjs build-jit/qjs
REQUESTS=5000 node benchmarks/http_server_throughput.mjs --server node --keep-alive 0
REQUESTS=5000 node benchmarks/http_server_throughput.mjs --server qjs --qjs build-jit/qjs --keep-alive 0
node benchmarks/startup_real_200k.mjs --qjs build-jit/qjs --node node
```

## Real 200k-Line Startup Corpus

`prepare_real_startup_corpus.mjs` downloads the pinned npm package `typescript@6.0.3` and copies `package/lib/typescript.js` into `benchmarks/corpus/typescript-6.0.3.js`.

The generated corpus is intentionally not committed. It is real published JavaScript, currently about 201k lines, and it runs successfully under both QuickJS and Node.

## Current Local Baseline

Measured on this machine with `build-jit/qjs` and Node `v24.14.0`:

| Benchmark | QuickJS JIT | Node/V8 |
| --- | ---: | ---: |
| encoding checksum | ~2.88 ms | ~16.1 ms |
| micro int arithmetic | ~9.75 ms/iter | ~9.78 ms/iter |
| micro int sum loop | ~1.95 ms/iter | ~1.97 ms/iter |
| micro typed array scan | ~1.67 ms/iter | ~7.98 ms/iter |
| micro property load | ~0.022 ms/iter | ~2.74 ms/iter |
| micro closure call | ~3.92 ms/iter | ~17.9 ms/iter |
| micro string hash | ~41.3 ms/iter | ~62.2 ms/iter |
| HTTP server, close-per-request, 64 conn | ~13.0k req/s | ~10.5k req/s |
| HTTP server, keep-alive, 1 conn | ~23.0k req/s | ~21.3k req/s |
| real 200k source startup | ~621 ms median | ~142 ms median |
| real 200k precompiled startup | ~45.6 ms median | n/a |

The current JIT is still shape-specialized. These numbers are a target matrix for turning the proof-of-concept into a real bytecode/IR optimizing tier without regressing the specialized fast paths.
