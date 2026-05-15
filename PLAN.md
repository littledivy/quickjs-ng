# QuickJS-NG JIT Plan

## Goal

Add a production-grade JIT compiler to QuickJS-NG that preserves ECMAScript correctness, keeps the engine embeddable, and creates a credible path toward performance in the same competitive class as modern JITed engines.

This plan is grounded in the current QuickJS-NG architecture:

- The compiler emits stack bytecode directly with no general-purpose IR.
- The interpreter and most runtime logic live in `quickjs.c`.
- Function execution is centralized in `JS_CallInternal()` and related call helpers in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:17460).
- The bytecode format is defined in [quickjs-opcode.h](/Users/divy/gh/quickjs-ng/quickjs-opcode.h:1).
- Runtime stack frames are represented by `JSStackFrame` in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:366).
- Executable function metadata is represented by `JSFunctionBytecode` in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:768).
- Closure capture is implemented through `JSVarRef` and `close_var_refs()` in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:404) and [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:17239).
- Property layout stability is expressed through `JSShape` in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:1015).
- Build surfaces already span CMake, Meson, and Make in [CMakeLists.txt](/Users/divy/gh/quickjs-ng/CMakeLists.txt:1), [meson.build](/Users/divy/gh/quickjs-ng/meson.build:1), and [Makefile](/Users/divy/gh/quickjs-ng/Makefile:1).

Two practical consequences matter immediately:

- There is no existing VM-tiering or hotness subsystem to reuse.
- Existing interpreter fast paths are already shape-driven and should become the semantic template for the first IC/JIT guards.

## Executive Summary

If the target is merely "faster than the interpreter", a baseline JIT is feasible.

If the target is "state-of-the-art comparable to V8", this is not a single feature. It is a multi-year VM program that requires:

- A tiered execution pipeline.
- Stable runtime metadata for speculation.
- Deoptimization and on-stack replacement.
- Safepoints and GC root maps.
- Inline caches and feedback vectors.
- Machine-level calling conventions.
- Optimization IR and lowering pipeline.
- Architecture-specific code generation.
- Benchmarking, fuzzing, and continuous correctness validation.

The fastest credible route is:

1. Build an optional baseline JIT first.
2. Introduce feedback collection and inline caches.
3. Add deopt and OSR.
4. Add a higher-tier optimizing compiler.
5. Only then pursue V8-class throughput on selected benchmarks.

The most important strategic decision is this:

QuickJS-NG should not try to jump directly from the current interpreter to a V8-like optimizing JIT. It should first become a VM with explicit execution tiers and stable speculation/deoptimization infrastructure.

## Reality Check

### What makes this hard in this codebase

- The engine is intentionally compact and interpreter-centric.
- There is no existing SSA or low-level IR for optimization.
- Fast paths are embedded directly in interpreter opcode cases, for example `OP_get_field`, `OP_put_field`, and `OP_get_length` in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:17648).
- Stack frames are stack-allocated for ordinary bytecode calls via `alloca()` in `JS_CallInternal()` in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:17547), while generators/async functions use heap-backed suspended frames in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:20355).
- Reference counting and cycle collection mean JIT code must preserve precise ownership and root visibility on every edge, not only at safepoints.
- The project supports many platforms, including Windows, macOS, Linux, BSDs, Android, iOS, MinGW, and WASI-adjacent build paths; see [docs/docs/supported_platforms.md](/Users/divy/gh/quickjs-ng/docs/docs/supported_platforms.md:1).

### What this means for scope

There are two plausible end states:

- `Plan A`: Add a good JIT while preserving QuickJS-NG’s identity as a compact embeddable engine.
- `Plan B`: Re-architect enough of the VM that it stops looking like "small QuickJS with a JIT" and starts looking like a new engine that happens to preserve QuickJS APIs and semantics.

V8-class performance across broad workloads implies `Plan B` over time.

This document therefore describes a staged program where each stage is useful on its own, but later stages are intentionally allowed to force deeper VM refactors.

## Non-Goals For Phase 1

- No attempt to match V8 on all JavaScript workloads in the first tier.
- No immediate support for every architecture in JIT mode.
- No speculative optimization of `eval`, proxies, megamorphic property access, or exotic object behavior in the first tier.
- No optimizing JIT before baseline JIT, feedback, deopt, and safepoints exist.
- No platform-wide executable-memory support for sandboxed targets such as some iOS/WASI configurations in the initial landing.

## Guiding Principles

1. Preserve correctness first.
2. Keep the interpreter as the authoritative semantic fallback.
3. Make the JIT optional at build time and runtime.
4. Keep all speculative assumptions explicit and invalidatable.
5. Build for tiering from day one, even if only one JIT tier exists initially.
6. Add observability early: counters, traces, disassembly, bailout reasons, and perf telemetry.
7. Prefer architecture isolation over spreading machine code generation throughout `quickjs.c`.

## Proposed End-State Architecture

### Tier model

- Tier 0: Current interpreter.
- Tier 1: Baseline JIT lowering QuickJS stack bytecode to native code with minimal speculation.
- Tier 2: Optimizing JIT using collected feedback, typed nodes, guards, LICM, inlining, escape analysis where possible, and register allocation.

### Main execution objects

Add new VM-owned structures roughly along these lines:

- `JSJitConfig`
  Runtime and build-time JIT flags, thresholds, architecture support, logging.
- `JSJitFunction`
  Per-function JIT state keyed from `JSFunctionBytecode`.
- `JSFeedbackVector`
  Slot-based feedback for calls, globals, property access, arithmetic, branches.
- `JSCodeBlock`
  Executable native code plus metadata: entrypoints, safepoints, deopt maps, relocation records.
- `JSInlineCache`
  Per-site monomorphic/polymorphic caches.
- `JSDeoptMetadata`
  Maps native state back to interpreter state.
- `JSSafepointTable`
  PC-to-root-map data for GC and exception handoff.
- `JSJitBackend`
  Target-specific machine code emitter abstraction.

### File/module split

Do not keep JIT code inside `quickjs.c` beyond a narrow dispatch layer. Introduce a `jit/` subtree:

- `jit/jit.h`
- `jit/jit.c`
- `jit/jit-internal.h`
- `jit/bytecode-lir.c`
- `jit/feedback.c`
- `jit/deopt.c`
- `jit/safepoint.c`
- `jit/ic.c`
- `jit/backend/backend.h`
- `jit/backend/x64/*.c`
- `jit/backend/aarch64/*.c`
- `jit/ir/*.c`
- `jit/tests/*`

Also add a thin runtime bridge:

- `quickjs-jit-bridge.c`

This bridge should be the only major JIT-aware file outside the JIT subtree besides minimal hooks in `quickjs.c`.

## Core Technical Decisions

## 1. Baseline compiler input representation

### Recommendation

Use QuickJS bytecode as the source for baseline compilation, but normalize it into a control-flow graph first.

### Why

- The current bytecode is stack-based and compact, but not directly suitable for optimization.
- A baseline tier can still compile from bytecode without requiring parser changes.
- A CFG normalization pass creates immediate value even before an optimizing tier exists.

### Required work

- Parse bytecode blocks and branch targets from `byte_code_buf`/`byte_code_len` in `JSFunctionBytecode`.
- Model interpreter stack depth per program point using logic conceptually aligned with `compute_stack_size()` in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:35190).
- Build a bytecode CFG and virtual operand stack model.
- Assign virtual registers or stack slots to stack values.
- Materialize exception edges and handler targets.

### Deliverable

A reusable mid-level representation:

- basic blocks
- bytecode instructions
- virtual stack effects
- exception successors
- source/pc mappings

This is the minimum substrate for both baseline codegen and later optimization.

## 2. Tiering entrypoint

### Recommendation

Keep `JS_CallInternal()` as the initial dispatch point, but factor it into:

- interpreter entry
- tiering check
- JIT entry
- deopt resume

### Required refactor

Refactor the large function into smaller helpers before adding JIT logic:

- `js_call_prepare_frame()`
- `js_interpret_function()`
- `js_maybe_tier_up()`
- `js_enter_jit_code()`
- `js_resume_after_deopt()`

The initial compiled-function check should happen after resolving `b = p->u.func.function_bytecode` and before ordinary frame allocation. That keeps the gate narrow and avoids spreading tiering checks across opcode handlers.

### Reason

Right now `JS_CallInternal()` owns:

- function dispatch
- frame allocation
- interpreter loop
- generator resume logic
- exception unwinding

Without isolating these responsibilities first, every later JIT change will be fragile.

## 3. Frame model

### Current constraint

Ordinary frames are native C stack allocations plus arrays created with `alloca()`, while suspended async/generator frames are heap-backed.

### Recommendation

Introduce an explicit VM frame descriptor that can represent:

- interpreter frames
- JIT frames
- deoptimized materialized frames
- suspended generator/async frames

### Required data

- frame kind
- pointer to `JSFunctionBytecode`
- `this`, arguments, locals, operand stack base
- native return address or code block ID
- deopt metadata handle
- exception handler state
- var-ref visibility

### Why

V8-class tiering requires:

- stack walking across mixed interpreter/JIT frames
- GC root enumeration
- accurate exceptions and backtraces
- OSR into and out of loops

The current `JSStackFrame` is close to the semantic frame but not sufficient as the sole cross-tier stack-walking abstraction.

### Baseline implementation rule

Reuse the current contiguous logical frame layout for baseline JIT:

- arguments
- locals
- operand stack
- `var_ref` table

That layout already exists in `JS_CallInternal()` and is the lowest-risk way to make deopt and interpreter re-entry tractable.

## 4. GC and root management

### Current constraint

QuickJS-NG uses reference counting plus cycle removal. JIT code cannot treat `JSValue` temporaries like raw machine values without a precise policy for:

- incref/decref insertion
- spills
- deopt state reconstruction
- exception exits
- safepoint root reporting

### Recommendation

Define a strict JIT ownership model for `JSValue`:

- Values in known tagged immediate forms need no refcount action.
- Values holding refcounted payloads must have explicit ownership state.
- JIT temporaries must be classified as borrowed, owned, or materialized.
- Every safepoint must have a root map covering live owned references.

### Phase 1 policy

Be conservative:

- Materialize most `JSValue` results in memory frame slots.
- Use helper calls for operations that produce or consume refcounted values.
- Emit explicit incref/decref around helper boundaries.
- Defer aggressive reference elision until correctness tooling exists.

### Required supporting work

- GC root map format for JIT frames.
- Stack walker integration for JIT frames.
- Verification mode that cross-checks root maps against deopt materialization in debug builds.
- Leak and refcount delta tracing in JIT-only tests.

## 5. Exception and bailout model

### Recommendation

Do not implement full native exception semantics inside the baseline tier. Use side exits to shared runtime stubs.

### Mechanism

- Any operation that can throw calls a helper or emitted stub.
- Helpers return a result plus exception status.
- On exception, control transfers to a JIT epilogue that:
  - records current bytecode pc
  - materializes interpreter-visible frame state
  - restores `rt->current_stack_frame`
  - enters the existing exception path

### Why

QuickJS relies heavily on the current exception object and bytecode PC for backtraces, for example around `needs_backtrace()` and the `exception:` path in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:17453) and [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:20119).

Trying to bypass this early would multiply correctness risk.

## 6. Property access and shapes

### Current opportunity

QuickJS shapes already provide stable structural identity for many objects.

### Recommendation

Make shapes first-class guard inputs for JIT and ICs.

### Phase 1 approach

- Add monomorphic inline caches for:
  - named load
  - named store
  - method load
  - array length
- Guard on:
  - object tag
  - `JSShape *`
  - property slot index
  - property mode flags where needed
- Fall back to runtime helper on:
  - exotic objects
  - accessors
  - prototype-chain mutation
  - proxies
  - private field edge cases

### Required invalidation work

Add versioning or dependency tracking so speculative code can be invalidated when:

- a shape changes
- a prototype chain changes
- a property becomes accessor-backed
- array fast path assumptions break

Current shape transitions are local and pointer-based; there is no global dependency mechanism today. That must be added.

The initial implementation should deliberately model current interpreter fast paths in `OP_get_field`, `OP_get_field2`, `OP_put_field`, and `OP_get_length` rather than inventing a new property semantics layer first.

## 7. Feedback collection

### Recommendation

Add feedback vectors before serious optimization.

### Slots to collect

- call target identity
- constructor call target identity
- branch taken/not-taken counts
- arithmetic operand type classes
- named load/store receiver shapes
- keyed access classes
- global var access stability
- array element access mode

### Storage

Attach a `JSFeedbackVector *` to `JSFunctionBytecode` or `JSJitFunction`.

The safer first step is to keep JIT state in a non-serialized sidecar attached to `JSFunctionBytecode`, not in the bytecode serialization format. That avoids destabilizing bytecode read/write paths while the runtime execution model is still changing.

### Use

- trigger tier-up
- choose monomorphic vs polymorphic stubs
- decide inlining candidates
- specialize arithmetic and comparisons

## 8. Baseline JIT design

### Baseline goals

- Reduce interpreter dispatch overhead.
- Keep correctness very close to interpreter semantics.
- Use helper calls for complex ops.
- Gather feedback cheaply.

### Compilation strategy

- Lower each bytecode basic block to native code.
- Keep the virtual operand stack in a mix of machine registers and frame slots.
- Use fixed ABI-compatible helper calls for complex operations.
- Store bytecode pc mapping for every safepoint and helper boundary.

Safepoints should initially align with existing interpreter slow edges:

- call and constructor call sites
- helper-backed property operations
- throws
- backward branches
- yield/await boundaries once supported

This matches the current `cur_pc` discipline and preserves backtrace/exception expectations.

### Baseline specialization allowed

- immediate integer arithmetic fast paths
- direct boolean branch fast paths
- monomorphic named property load/store
- direct call stubs when callee identity is stable and calling convention matches
- array length and dense array fast reads
- typed array indexed access when buffer and bounds conditions are trivially guarded

### Baseline specialization not required initially

- general inlining
- scalar replacement
- LICM
- global value numbering
- escape analysis
- polymorphic inlined caches beyond low fan-out

### Initial backend target

Implement x86-64 first.

Reason:

- easiest initial bring-up for desktop development
- mature calling conventions
- simpler debug/disassembly ecosystem

Second backend:

- AArch64 for macOS/Linux

Do not attempt all supported platforms in the first JIT landing.

## 9. Optimizing JIT design

### Recommendation

Once baseline JIT, deopt, feedback, and safepoints are stable, add a proper optimizing IR.

### IR requirements

- SSA form
- explicit effect/control dependencies
- boxed and unboxed value types
- guard nodes
- deopt checkpoints
- call nodes with side-effect summaries
- heap and shape dependency annotations

### Pipeline

1. Bytecode CFG to high-level IR.
2. Abstract interpretation/type propagation from feedback and guards.
3. Lowering to machine-oriented IR.
4. Register allocation.
5. Code emission.

### Priority optimizations

- monomorphic and small-polymorphic inline caches
- typed arithmetic specialization
- branch simplification
- load/store elimination within guarded regions
- small function inlining
- loop invariant code motion
- bounds-check elimination for typed arrays and dense arrays
- allocation folding for short-lived objects where deopt permits

### Hard problems deferred until proven necessary

- broad escape analysis across closures
- advanced string specialization
- speculative object unboxing
- wasm-style register stackification

## 10. OSR and loop tier-up

### Recommendation

Add on-stack replacement after baseline tier is stable.

### Why

Without OSR, hot loops inside long-running functions stay trapped in the interpreter or baseline entry prologue too long.

### Mechanism

- Insert lightweight interrupt/tiering polls at loop headers, reusing the current interrupt discipline where possible.
- When a threshold is crossed, compile the current function or loop region.
- Map current interpreter stack/locals to JIT frame state.
- Jump into a JIT OSR entrypoint at the loop header.

### Reverse OSR

Deopt must support:

- reconstructing locals
- reconstructing operand stack contents
- restoring bytecode pc
- restoring live `JSVarRef` aliasing state

This is mandatory before any aggressive speculative optimization.

## 11. Closures, lexical environments, and `JSVarRef`

### Current constraint

Captured locals are represented through `JSVarRef`, and `close_var_refs()` detaches them when the frame exits.

### Recommendation

The JIT must treat captured locals as aliasable memory, not plain registers.

### Rules

- A captured local cannot be considered register-private across observable points.
- JIT frames need stable slots for any variable that may be exposed through `JSVarRef`.
- Closing a frame must correctly detach live refs exactly as interpreter code does.
- OSR/deopt metadata must preserve the relation between local slots and `JSVarRef::pvalue`.

### Practical baseline choice

Phase 1 JIT should pin all captured locals to frame memory slots and access them through helper-aware abstractions.

## 12. Generators and async functions

### Current constraint

Generators and async functions already use heap-backed suspended state via `JSAsyncFunctionState` in [quickjs.c](/Users/divy/gh/quickjs-ng/quickjs.c:872).

### Recommendation

Do not support JIT suspension/resume immediately.

### Staged support

- Phase 1: interpreter only for generator/async bodies.
- Phase 2: baseline JIT for generator/async bodies with mandatory deopt before suspension points.
- Phase 3: native suspend/resume support with resumable JIT frames.

### Why

Resumable JIT state is one of the most failure-prone VM features. It should not block baseline wins on ordinary functions.

## 13. `eval`, modules, proxies, and exotic behavior

### `eval`

Direct `eval` can invalidate assumptions about locals, scope, and globals. Initial policy:

- either disable optimized JIT for functions requiring difficult `eval` semantics
- or allow baseline JIT but force conservative helper-based accesses and limited speculation

### Proxies/exotics

Any guard region involving proxies or exotic methods should bail out immediately.

### Modules

Modules should work in baseline JIT as long as import/export accesses go through existing helper logic. Optimized direct linking can come later.

## 14. C API and embedding contract

### Required guarantees

- Existing C API behavior remains unchanged when JIT is disabled.
- JIT can be fully disabled at build time and runtime.
- Bytecode serialization format remains compatible unless explicitly version-gated.
- Stack traces, interrupts, and memory limits keep working.

### New API surface

Add opt-in configuration:

- `JS_SetJitEnabled(rt, bool)`
- `JS_SetJitTieringConfig(rt, const JSJitConfig *)`
- `JS_RunGC(rt)` remains authoritative and must see JIT roots.
- diagnostic APIs:
  - JIT code stats
  - per-function tier
  - deopt counts
  - bailout reason summaries

## 15. Build and platform strategy

### Build flags

Add a unified optional JIT flag across all build systems:

- CMake: `QJS_ENABLE_JIT`
- Meson: `-Djit=true`
- Make: pass-through to CMake

### Per-backend flags

- `QJS_JIT_X64`
- `QJS_JIT_AARCH64`

Initial hard-disabled targets should include at least:

- WASI
- Emscripten
- DJGPP
- first-wave Apple restricted targets such as iOS/tvOS/watchOS

until executable-memory policy, cache flushing, and unwind behavior are solved explicitly.

### Executable memory abstraction

Add a platform layer for:

- `mmap`/`mprotect`
- `VirtualAlloc`/`VirtualProtect`
- instruction cache flush
- W^X policy handling

### Platform rollout

1. Linux x86-64
2. macOS x86-64 / AArch64
3. Linux AArch64
4. Windows x86-64

Everything else remains interpreter-only until explicitly supported.

## 16. Testing strategy

### Correctness gates

Every JIT stage must pass:

- existing `make test`
- `test262`
- JIT-on and JIT-off modes
- forced-tier mode
- forced-deopt mode
- randomized tiering thresholds
- stress GC mode

### New test classes

- bytecode-to-JIT conformance tests
- deopt reconstruction tests
- root-map/GC stress tests
- closure capture tests
- exception/backtrace parity tests
- prototype mutation invalidation tests
- shape transition invalidation tests
- typed array bounds and detach stress tests
- generator/async fallback tests

### CI rollout

Recommended CI order:

1. Linux release with JIT enabled
2. Linux ASan/UBSan with JIT enabled
3. Linux `test262-fast` with JIT enabled
4. Meson Linux debug/release with JIT enabled
5. macOS release with JIT enabled
6. Windows x64 once executable-memory and unwind support are stable

Meson parity is required immediately, not after the CMake implementation lands.

### Differential testing

Run the same test corpus in:

- interpreter only
- baseline JIT forced
- optimizing JIT forced
- randomized deopt points

and compare:

- result values
- thrown exceptions
- stack traces where stable
- memory leak/refcount behavior

### Fuzzing

Add JIT-aware fuzzing modes:

- random tier-up points
- random IC invalidations
- random GC at safepoints
- random deopt on guards

## 17. Benchmark strategy

### Near-term benchmark suite

Start with existing [tests/microbench.js](/Users/divy/gh/quickjs-ng/tests/microbench.js:1) and add:

- property access
- arithmetic loops
- calls
- object allocation
- array iteration
- typed arrays
- JSON
- regexp

### Serious benchmark suite

Add external benchmarks gated in CI or scheduled runs:

- JetStream fragments
- Speedometer-relevant kernels
- ARES-like numeric kernels
- real-world transpiled framework bundles
- parser/compiler workloads

### Metrics

- warmup time
- steady-state throughput
- memory overhead
- code cache size
- deopt rate
- IC hit rate
- compile time per function

### Success framing

Do not compare to V8 on day one.

Use milestone targets:

- M1: 1.5x to 3x over interpreter on dispatch-heavy microbenches.
- M2: 3x to 8x on arithmetic/property microbenches.
- M3: competitive with lower-tier JIT engines on selected app kernels.
- M4: narrow workload parity with V8 on specifically optimized kernels.

Broad V8 parity is a later research target, not an MVP acceptance criterion.

## 18. Observability and debug tooling

Add:

- per-function tier state
- JIT disassembly dump
- IR dump
- CFG dump
- IC state dump
- deopt reason histogram
- code cache stats
- safepoint table dump
- root-map verifier
- optional "execute in both interpreter and JIT, compare at checkpoints" debug mode

This is not optional. Without it, the project will stall on correctness bugs.

## 19. Security and hardening

### Risks introduced by JIT

- writable+executable memory mistakes
- malformed metadata causing memory corruption
- incorrect deopt/root maps causing use-after-free or leaks
- ABI mismatches across platforms

### Required mitigations

- strict W^X
- centralized code allocator
- relocation validation in debug builds
- metadata bounds checks
- hardened code cache free list management
- no self-modifying code
- separate constant pools from executable pages where practical

## 20. Proposed implementation phases

## Phase 0: Feasibility and refactor prep

Duration: 4-8 weeks

Deliverables:

- Refactor `JS_CallInternal()` into smaller helpers.
- Introduce `jit/` directory and build toggles.
- Add a no-op tiering path and per-function hotness counters.
- Add function metadata extension points on `JSFunctionBytecode`.
- Add benchmark harness extensions.
- Add JIT design docs and debug dump plumbing.

Exit criteria:

- No behavior change with JIT disabled.
- Clean compile across supported non-JIT platforms.

## Phase 1: Baseline infrastructure

Duration: 6-10 weeks

Deliverables:

- Bytecode CFG builder.
- Virtual stack analysis.
- JIT code allocator and backend abstraction.
- JIT frame metadata format.
- Safepoint metadata format.
- Runtime helper ABI.

Exit criteria:

- Can compile a trivial function to native code and call it.
- Correct fallback to interpreter on unsupported ops.

## Phase 2: x86-64 baseline JIT

Duration: 10-16 weeks

Deliverables:

- Native lowering for:
  - constants
  - local/arg access
  - branches
  - simple arithmetic
  - returns
  - helper-based calls
  - helper-based property operations
- JIT entry from `JS_CallInternal()`
- exception exit path
- GC safepoints

Exit criteria:

- `make test` passes in forced-baseline mode for a constrained supported subset.
- microbench speedups are measurable.

## Phase 3: Feedback and inline caches

Duration: 8-12 weeks

Deliverables:

- feedback vectors
- monomorphic named load/store ICs
- call ICs
- invalidation hooks on shape/prototype mutation

Exit criteria:

- stable IC invalidation
- improved property/call benchmarks

## Phase 4: Deopt and OSR

Duration: 10-16 weeks

Deliverables:

- deopt metadata
- interpreter reconstruction
- loop OSR entry
- forced deopt stress mode

Exit criteria:

- randomized deopt testing passes
- long-running hot loops tier up without semantic regressions

## Phase 5: AArch64 backend

Duration: 6-10 weeks

Deliverables:

- AArch64 baseline backend
- cache flush support
- macOS/Linux validation

Exit criteria:

- baseline JIT works on Apple Silicon and Linux AArch64

## Phase 6: Optimizing tier foundation

Duration: 12-20 weeks

Deliverables:

- SSA IR
- type/shape feedback propagation
- guard/deopt checkpoints
- register allocator

Exit criteria:

- small optimized kernels beat baseline tier materially

## Phase 7: Optimizing tier maturity

Duration: ongoing, likely 12+ months

Deliverables:

- inlining
- typed arithmetic specialization
- improved array and typed-array optimization
- object allocation fast paths
- loop opts
- broader IC polymorphism

Exit criteria:

- competitive results on selected macro workloads

## Phase 8: Advanced language/runtime support

Duration: ongoing

Deliverables:

- generators/async in JIT
- improved `eval` handling
- better module optimization
- broader platform support

## 21. Highest-risk technical blockers

1. Refcount correctness in generated code.
2. Deopt reconstruction of `JSValue` and captured locals.
3. Mixed stack walking across interpreter and JIT frames.
4. Shape/prototype invalidation correctness.
5. Keeping compile time small enough for an embeddable engine.
6. Preventing `quickjs.c` from becoming even harder to maintain.
7. Cross-platform executable-memory support and cache flushing.
8. Generator/async suspension semantics.

## 22. Recommended first code changes

Before writing any machine code emitter, land these preparatory changes:

1. Split `JS_CallInternal()` into setup, dispatch, interpret, and unwind helpers.
2. Add `JSFunctionBytecode` extension storage for tiering state and feedback handles.
3. Add per-function execution counters and hotness thresholds.
4. Add a bytecode CFG builder and validator in `jit/`.
5. Add a platform-neutral executable code allocator.
6. Add JIT build flags to CMake, Meson, and Make.
7. Add debug dumping for per-function bytecode CFG and tier state.
8. Keep generators/async on the interpreter until ordinary-function baseline JIT is stable.

These changes are low-regret even if the full JIT takes longer than expected.

## 23. Recommended acceptance criteria by milestone

### Milestone A: "JIT skeleton exists"

- optional build works
- native code for trivial functions works
- no regressions with JIT off

### Milestone B: "Baseline tier is real"

- forced-baseline mode passes most internal tests
- stable speedup on property/arithmetic/call microbenches
- exception and GC correctness holds under stress

### Milestone C: "Tiering is real"

- feedback collection works
- hot functions tier up automatically
- monomorphic ICs improve common object-heavy code

### Milestone D: "Optimization pipeline exists"

- deopt works
- OSR works
- optimized tier shows wins beyond dispatch removal

### Milestone E: "Competitive engine direction"

- respectable macrobenchmark results on x86-64 and AArch64
- stable developer tooling and CI
- clear data on how far the engine remains from V8 on representative workloads

## 24. Final recommendation

Proceed, but be explicit about the program you are starting.

If the true goal is "make QuickJS noticeably faster while preserving its small-engine value proposition", stop after a strong baseline JIT plus ICs unless data justifies more.

If the true goal is "make QuickJS state-of-the-art comparable to V8", commit up front to:

- significant VM restructuring
- at least two JIT tiers
- multiple architecture backends
- long-term benchmarking and fuzzing infrastructure
- a multi-quarter or multi-year roadmap

The correct first step is not code generation. The correct first step is turning the current interpreter-centered runtime into a tierable VM with explicit metadata ownership, invalidation, deopt, and GC boundaries.
