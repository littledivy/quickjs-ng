# QuickJS-NG Experimental JIT

This document describes the experimental JIT implementation in this branch. It is intentionally specific about terms, current behavior, and what is not implemented yet so future work can move toward a real V8-class tiering pipeline without confusing benchmark fast paths for a general optimizer.

## Goals

- Preserve QuickJS semantics first. A JIT result must be indistinguishable from interpreter execution.
- Make C runtime calls first-class JIT operations. Calling QuickJS C helpers from JIT code is not a deopt by itself.
- Use explicit guard failure as the only normal interpreter re-entry path.
- Build in tiers: fast native stubs, baseline C-call lowering, then a future optimizing IR tier.
- Keep every benchmark reproducible and comparable against Node/V8.

## Definitions

- **Interpreter**: The existing QuickJS bytecode interpreter in `JS_CallInternal()`.
- **JIT entry**: A native function pointer stored on `JSFunctionBytecode::jit_entry`.
- **Fast path**: Small native AArch64 stubs for exact bytecode shapes. Examples include constant return and byte-oriented integer helpers.
- **Baseline C-call tier**: A compiled entry stub that jumps to a C helper implementing a proven bytecode shape. This is a tier, not a deopt, because execution remains in the JIT-selected compiled body.
- **Optimizing tier**: Future tier that should lower bytecode to a real IR, specialize from feedback, emit machine code, and support deopt metadata.
- **Guard**: A runtime check that validates assumptions such as argument tags, typed array class, or string encoding.
- **Deopt**: Returning `JS_UNINITIALIZED` from a JIT helper to tell `js_jit_try_call()` to re-enter the interpreter for the same call.
- **Exception**: Returning `JS_EXCEPTION`. This is not a deopt. It preserves normal QuickJS exception propagation.
- **C runtime call**: Any call from JIT-selected code into existing QuickJS C APIs or purpose-built C helpers. It is not a deopt unless the helper explicitly returns `JS_UNINITIALIZED`.

## Current Architecture

The hook is in `JS_CallInternal()` after the callee bytecode is resolved and before the interpreter frame is allocated. Non-constructor calls attempt `js_jit_try_call()`.

`JSFunctionBytecode` stores:

- `jit_entry`: Native entry pointer.
- `jit_code`: Executable allocation backing the entry.
- `jit_code_size`: Allocation size for cleanup.
- `jit_call_count`: Number of calls that entered compiled code.
- `jit_deopt_count`: Number of guard-failure interpreter re-entries.
- `jit_status`: `none`, `unsupported`, or `compiled`.
- `jit_tier`: `none`, `fastpath`, `baseline-ccall`, or future `opt`.

Compiled entries use this ABI:

```c
typedef JSValue (*JSJitEntryFunc)(JSContext *ctx,
                                  JSFunctionBytecode *b,
                                  int argc,
                                  JSValueConst *argv,
                                  JSValueConst func_obj);
```

The return contract is:

- Any normal `JSValue`: use it as the call result.
- `JS_EXCEPTION`: propagate the exception normally.
- `JS_UNINITIALIZED`: guard failed, re-enter the interpreter.

This means C calls do not deopt. They are normal compiled-tier implementation details unless they intentionally return the deopt sentinel.

## Tiers

### Tier 0: Interpreter

The existing QuickJS interpreter remains the semantic source of truth.

### Tier 1: Fastpath Native Stubs

Small AArch64 stubs are emitted directly for exact bytecode shapes where the generated code is trivial and self-contained.

Current examples:

- Return constant.
- Return atom value.
- Return `undefined`.
- `pack24(a, b, c)`.
- `b64QuadChecksum(a, b, c)`.

### Tier 1.5: Baseline C-Call Tier

This tier recognizes stable bytecode shapes and compiles the function entry to a native jump into a C helper. The helper performs guards, uses existing C APIs as needed, and returns normal `JSValue` results.

Current examples:

- `encodeChecksum(Uint8Array, rounds)`.
- Microbenchmark integer arithmetic.
- Microbenchmark typed array scan.
- Microbenchmark property load.
- Microbenchmark closure call.
- Microbenchmark string hash.

This tier is useful now because it establishes:

- Stable JIT call ABI.
- C helper semantics.
- Guard/deopt contract.
- Per-function tier metadata and counters.
- Benchmark harnesses that expose the next bottlenecks.

It is not a general optimizer yet.

### Tier 2: Optimizing IR Tier

Not implemented yet. This should be the next major step.

Expected components:

- Bytecode decoder to a compact IR.
- Basic block and control-flow graph construction.
- Stack-to-SSA conversion for bytecode stack values.
- Type feedback and inline cache feedback.
- Guard insertion with deopt metadata.
- Register allocation.
- AArch64 code generation.
- Safepoints for GC visibility.
- OSR for hot loops.

## C Calls and Deopt Semantics

C calls are allowed in every tier. The key rule is that helper return values have explicit meaning.

Example helper behavior:

```c
if (unexpected_shape)
    return JS_UNINITIALIZED; /* deopt */
if (runtime_error)
    return JS_EXCEPTION;    /* not deopt */
return js_int32(result);    /* compiled result */
```

This matches how production JITs treat runtime stubs: calling a stub is not deoptimization; only failed speculative assumptions require deopt.

Guard failures are currently coarse. The function call restarts in the interpreter, so side-effecting helpers must only return `JS_UNINITIALIZED` before externally visible side effects.

## Current Benchmarks

Run:

```sh
cmake -S . -B build-jit -DCMAKE_BUILD_TYPE=Release -DQJS_ENABLE_JIT=ON
cmake --build build-jit -j8
node benchmarks/run_benchmarks.mjs
```

Current local matrix:

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

## Samples

### Enable Tracing

```sh
QJS_JIT_TRACE=1 build-jit/qjs benchmarks/micro_jit.js
```

Trace lines include tier and name:

```text
qjs jit: compiled tier=baseline-ccall name=micro-typed-array-scan function 0x...
```

Guard deopts include counters:

```text
qjs jit: deopt tier=baseline-ccall function 0x... calls=12 deopts=1
```

### Dump Optimizer CFG

```sh
QJS_JIT_DUMP_IR=1 build-jit/qjs -e 'function f(x){let y=x|0; for(let i=0;i<3;i++) y=(y+i)|0; return y} print(f(4))'
```

The current optimizer dump includes a bytecode-level control-flow graph and a linear stack-to-SSA trace. The CFG identifies basic block leaders, branch targets, and loop backedges:

```text
qjs jit-ir: function=0x... bytecode=47 argc=1 locals=2 stack=2 insns=27 blocks=4
qjs jit-ir:   loops=1
qjs jit-ir:   block B1 [12,19)
qjs jit-ir:     0017 if_false8 -> 43
qjs jit-ir:   block B2 [19,43)
qjs jit-ir:     0041 goto8 -> 12 backedge
qjs jit-ssa:   0025 v6 = add v2, v3
qjs jit-ssa:   0041 goto -> 12 backedge
qjs jit-ssa:   0046 return v8
```

The first native optimizer lowering consumes this shape for a guarded int32 induction loop:

```js
function f(seed) {
  let x = seed | 0;
  for (let i = 0; i < CONSTANT; i++) {
    x = (x + i) | 0;
  }
  return x;
}
```

On AArch64 the lowering checks that `argc >= 1` and `argv[0]` is already `JS_TAG_INT`, then executes the loop in native integer registers. If a guard fails it returns `JS_UNINITIALIZED`, which means interpreter fallback/deopt. This is different from baseline C-call helpers: C helper calls are normal compiled execution and do not count as deopts.

### Build Without JIT

```sh
cmake -S . -B build-nojit -DCMAKE_BUILD_TYPE=Release -DQJS_ENABLE_JIT=OFF
cmake --build build-nojit -j8
```

### Use QuickJS Precompiled Startup

```sh
build-jit/qjs --compile benchmarks/corpus/typescript-6.0.3.js --out /tmp/ts-qjs
/tmp/ts-qjs
```

## Research References

- Deutsch and Schiffman, “Efficient Implementation of the Smalltalk-80 System”, 1984. Early inline caching and dynamic language implementation work.
- Hölzle, Chambers, and Ungar, “Optimizing Dynamically-Typed Object-Oriented Languages With Polymorphic Inline Caches”, ECOOP 1991.
- Chambers and Ungar, “Customization: Optimizing Compiler Technology for SELF”, PLDI 1989.
- Gal et al., “Trace-based Just-in-Time Type Specialization for Dynamic Languages”, PLDI 2009. TraceMonkey lineage.
- Hackett and Guo, “Fast and Precise Hybrid Type Inference for JavaScript”, PLDI 2012. IonMonkey-style type analysis background.
- Wimmer and Franz, “Linear Scan Register Allocation on SSA Form”, CGO 2010.
- Click and Paleczny, “A Simple Graph-Based Intermediate Representation”, 1995. Sea-of-nodes style IR background used by modern optimizing compilers.
- V8 design docs: Ignition bytecode interpreter, Sparkplug baseline compiler, Maglev mid-tier compiler, and TurboFan optimizing compiler.
- JavaScriptCore design docs: LLInt, Baseline JIT, DFG, and FTL tiers.
- QuickJS source code: `JS_CallInternal()`, bytecode op definitions, and existing C runtime helpers are the implementation reference for semantics.

## Process for Future Sessions

1. Read this file and `benchmarks/README.md` before changing code.
2. Preserve the C-call contract: C helper calls are not deopts; only `JS_UNINITIALIZED` means deopt.
3. Prefer optimizer infrastructure over new benchmark-specific matchers.
4. Use `QJS_JIT_DUMP_IR=1` to inspect bytecode CFG and stack-SSA traces before adding lowering logic.
5. Keep guard failures side-effect free before returning `JS_UNINITIALIZED`.
6. Run `cmake --build build-jit -j8` after engine changes.
7. Run `build-jit/run-test262 -c tests.conf` after semantic changes.
8. Run `node benchmarks/run_benchmarks.mjs` after performance changes.
9. Update this file when tier semantics, deopt behavior, or optimizer phases change.
10. Update benchmark numbers only from a fresh local run and note if a benchmark changes shape.

## Next Engineering Steps

1. Convert stack bytecode to a small SSA-like IR for integer, typed-array, property, and call operations.
2. Add type feedback storage to `JSFunctionBytecode` or a side table.
3. Add inline caches for property loads and calls.
4. Lower simple loops to AArch64 machine code with deopt metadata.
5. Add safepoints so compiled code can cooperate with GC.
6. Replace benchmark-specific helpers with generic IR patterns.

The current implementation deliberately keeps semantics conservative. The next milestone is not more benchmark matchers; it is generic bytecode-to-IR lowering with the same C-call and deopt contract documented here.
