# Lightweight AST integration and independent Babel reference

The working-tree application now imports the Acorn + Astring core from `src/ast/` through the existing typed API modules. Babel is retained as a **frozen, development-only reference** under `experiments/lightweight-ast/babel/`. The old experiment entrypoints re-export the shipped implementation; there is no duplicate pilot implementation or runtime Babel fallback. This is a local controlled integration, **not a published release**.

## Reproduce

- `pnpm pilot:ast`: independently bundle the frozen Babel reference, the integrated Acorn compiler, and the real Worker runtime. Compare complete event/result snapshots on six bundled examples, 29 hand-written snippets, and **241 bounded differential cases** (154 from fixed seed `0x5eed1234`, 75 loop/body combinations and 12 targeted modern-syntax cases). Also check nine paste → input → analysis → argument → trace workflows, a 38-source syntax/error-category matrix, five source-analysis error diagnostics, 26 input literal/error cases, and 15 responses from the bundled Worker **handler** invoked in Node with a structured-cloning `postMessage` stub. Parser wording/positions are not asserted equal; application-defined analysis errors are. Runs in CI.

- `pnpm pilot:browser`: run 14 paired cases through the actual bundled **module Worker in Chromium** via a loopback HTTP page and DevTools protocol. Covers sync mutation, generators, nested async, dynamic `import()` with a data URL, rejected promises, script failures, event/iteration caps and terminating a truly stuck Worker (`eval` bypasses instrumentation guards). It also checks the **application's actual `runCode` timeout** (350 ms) and a successful subsequent run. Three application-level runs also compare reference-aliased Babel modules with the unaliased integrated Vite modules (analysis, events, results). A non-networking probe observes that direct `globalThis`/`fetch` are shadowed, while `self.fetch`, indirect `eval`, and `Function` can still reach Worker globals. Compares real `postMessage` responses, ignoring elapsed duration only. Requires local Chrome/Edge (or `CHROME_PATH`); this is an explicit local check, **not** part of CI, and never falls back to a Node mock. Uses a disposable browser profile and loopback servers. Chrome and Edge both use Chromium, so this does **not** test a second browser engine.
- `pnpm pilot:production-e2e`: build temporary frozen-Babel-reference and unaliased integrated production assets, serve both on loopback, and compare seven successful UI/Worker runs, three rejected-source/input cases (before Worker creation, without input evaluation), and timeout/recovery in Chrome (Chromium channel), WebKit, and Firefox. Requires Playwright browser binaries (`pnpm exec playwright install --with-deps chromium firefox webkit` on Linux); on Windows it uses installed Chrome for Chromium and downloaded Firefox/WebKit. No engine fallback or silent skip; a launch failure fails the command. The separate `pilot-ast-e2e.yml` CI workflow runs it on Linux for pushes, pull requests, and manual dispatch.
- `pnpm pilot:build`: make two temporary Vite app builds: one redirecting **instrumentation, source analysis, and input parsing** to the frozen Babel reference, and one with the actual production imports unchanged. Module-graph assertions require the reference to contain Babel and all three reference modules, and require production to contain all three integrated cores and no Babel or experiment modules. This prevents accidental self-comparison. Compare the total raw/gzip size of **all emitted JavaScript**, including the worker. The temporary outputs are removed afterward; the repository's `dist` is unaffected. The cross-engine CI workflow also records this comparison in the Job Summary.

## Candidate contract and release gate (not yet a release promise)

The integrated implementation targets **trusted, self-contained JavaScript**, not TypeScript/JSX or arbitrary JavaScript equivalence. The bounded compatibility corpus covers function declarations/expressions/arrows, classes and accessors, arrays/objects, loops and branches, destructuring/rest parameters, generators, async functions/iteration, and a dynamic `import()` of a data-URL module. Top-level `await`, a direct `import`, re-export, default export, module dependency, decorator, or non-JavaScript syntax is outside the supported paste workflow. The final result and traced events are compared on the named corpus; parser error text/positions and instrumented source formatting are **not** promised identical. Getter-bearing and native-internal-state objects such as `Map`/`Date` are conservatively skipped for fine-grained observation, so an animation need not show every read/write. The source must provide a callable entry or a self-contained script as described in the main README. A generator entry is not automatically consumed; call `next()` explicitly. The identifier `__trace` is reserved for the instrumentation runtime. Public `.d.mts` declarations keep the existing TypeScript call sites strict, but the ESTree rewriting core itself remains JavaScript; these declarations are not a claim of fully typed compiler internals.

The input box accepts JSON or the documented literal-only subset. It never evaluates input expressions. Resource limits (2.5 s, 4,000 events, 10,000 iterations by default) are best-effort usability bounds, not a CPU/network/memory security policy: dynamic imports, `eval`, `Function`, and indirect access to Worker globals remain possible. **Only run code you trust**; do not paste secrets or code from an untrusted share link. The browser Worker is not a sandbox for hostile code.

Before the integrated working tree can be proposed for release, `pnpm pilot:ast`, `pnpm test`, and `pnpm build` must pass, and `pnpm pilot:production-e2e` must run the **temporary production-built assets** (not the Vite dev server) in Chromium, Firefox, and WebKit without skips. It compares the visible run completion, real module Worker responses and event streams for seven named UI cases plus timeout/recovery, the independent reference against integrated production in each engine, plus three rejection checks before Worker creation. This is a finite release gate, not proof for arbitrary code or a security certification. Install Playwright browsers for the target host; a missing browser engine or a divergent case blocks the gate; do not report the size delta as a shipped benefit. The current user-authorized integration changes the normal build, but publishing still requires a separate decision and a real CI run.

## Current controlled integration result (2026-10-31)

The user-authorized next step has now replaced all three normal application entrypoints: instrumentation, source analysis, and safe input parsing. `acorn`, `acorn-walk`, and `astring` are runtime dependencies; the four Babel packages are development-only reference/tooling dependencies. The public TypeScript API remains in place. No production alias or runtime Babel fallback is used.

Both the Windows host and a fresh Linux Docker install passed `pnpm pilot:ast` (241 bounded differential cases plus the additional workflows/matrices), `pnpm test` (**58 tests, including 10 new integration-contract tests**), `pnpm pilot:build`, and `pnpm build`. The Linux validation used the image/digest and clean frozen-lockfile procedure below, exited 0, and removed its test container. The integrated normal build no longer emits the former 575,406 B Babel chunk or the large-chunk warning.

| Linux engine | Frozen reference vs actual integrated production assets | Rejection and timeout/recovery |
| --- | --- | --- |
| Chromium | All 7 UI/real-module-Worker cases matched | 3 pre-Worker rejections; timeout/recovery passed in both variants |
| Firefox | All 7 UI/real-module-Worker cases matched | 3 pre-Worker rejections; timeout/recovery passed in both variants |
| WebKit | All 7 UI/real-module-Worker cases matched | 3 pre-Worker rejections; timeout/recovery passed in both variants |

The rejection checks cover static imports, TypeScript syntax, and expression-valued input; the input side-effect marker must remain absent. Parser diagnostic wording is deliberately not compared. Module-graph checks confirm that the reference is independent (396 emitted modules) and the unaliased integrated application uses all three new cores without Babel/experiment modules (80 emitted modules).

| Current build | All emitted JS raw (including Worker) | Sum of per-file gzip |
| --- | ---: | ---: |
| Frozen Babel reference | 1,090,813 B | 300,386 B |
| Actual integrated production imports | 430,405 B | 138,008 B |
| Difference | −660,408 B | −162,378 B (about 54.1%) |

The Windows Chrome developer probe was also rerun against the independent reference and integrated app: all 14 Worker pairs, the timeout/recovery check, and three app-level pairs passed. Its old 10-second Vite-page deadline failed during cold dependency optimization after the lockfile change; it now uses a bounded 60-second readiness check and disposable per-variant dependency caches, and the cold-cache rerun passed without changing event assertions. This developer-server probe is separate from the production-assets gate above.

Host and Linux measurements agree. These totals include lazy chunks that not every session downloads; they are **not a first-screen transfer saving**. The entry JS remains 258,173 B raw (gzip 83,027 → 83,029 B; content-hash references can change gzip by a few bytes). The benefit is the compiler/runtime-loading asset budget, not a 162 kB reduction of the initial entry.

The Linux CI workflow now checks the **integrated** production assets against the archived reference and writes the size comparison into its Job Summary. **GitHub CI has not run; no commit, push, tag, or release was made.** The gate remains finite, the trusted-code restriction still applies, and this integration is not an arbitrary-JavaScript compatibility or security certification.

## Historical pre-integration production-asset browser check

**2026-10-31, before controlled integration:** the bounded three-engine production-asset gate passed in Linux Docker with temporary pilot aliases. The official `mcr.microsoft.com/playwright:v1.64.1-noble` image (digest `sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea`) ran Node 24.22.1, pnpm 12.14.0, and the locked Playwright 1.64.1 package. The source was mounted read-only, copied without host `node_modules`, `.git`, or `dist`, and installed with `pnpm install --frozen-lockfile` inside the container. The validation container exited with code 0; no host production files were substituted.

| Linux engine | Production UI/Worker parity | Timeout termination and subsequent recovery |
| --- | --- | --- |
| Chromium | All 7 named cases matched, baseline vs pilot | Passed in both variants |
| WebKit | All 7 named cases matched, baseline vs pilot | Passed in both variants |
| Firefox | All 7 named cases matched, baseline vs pilot | Passed in both variants |

The same container also passed `pnpm pilot:ast` (including the 241-case bounded differential corpus), `pnpm test` (48 tests), and `pnpm build`. At that earlier checkpoint the normal production build still included Babel and its existing large-chunk warning. The separate Linux CI workflow is configured locally but has **not run on GitHub**; these local checks are not a CI result.

The earlier Windows check passed in Chrome/Chromium and WebKit; Windows Firefox still has the SideBySide `mozglue` launch blocker. The successful Linux Firefox run closes the missing-engine gap for this bounded gate, not that Windows installation issue. This does not prove arbitrary-JavaScript equivalence or hostile-code isolation. The gate passing allows an explicit integration decision; it does not automatically authorize a production substitution or release. That earlier checkpoint left the normal app on Babel; see the integration result below for the current state.

### Re-run in Docker from PowerShell

Start Docker Desktop in Linux-container mode and verify `docker info --format '{{.OSType}}'` prints `linux`. From the repository root, run:

```powershell
$script = @'
set -euo pipefail
mkdir -p /work
tar -C /source --exclude=./node_modules --exclude=./.git --exclude=./dist -cf - . | tar -C /work -xf -
cd /work
npm install --global pnpm@12.14.0
pnpm install --frozen-lockfile
pnpm pilot:production-e2e
pnpm pilot:ast
pnpm pilot:build
pnpm test
pnpm build
'@
docker run --rm --init --ipc=host `
  --mount "type=bind,source=$($PWD.Path),target=/source,readonly" `
  --workdir /work mcr.microsoft.com/playwright:v1.64.1-noble bash -lc $script
```

Use the image digest above when replaying this exact environment. Keep the image version aligned with the locked Playwright package if dependencies change. The container is only a test environment here; the application Worker is still restricted to trusted code by contract, not made into a hostile-code sandbox by this validation.

## Historical isolated-build measurement (before integration)

| Variant | All JS raw | All JS gzip |
| --- | ---: | ---: |
| Normal Babel build | 1,090,813 B | 300,386 B |
| Three-module pilot substitution | 430,413 B | 138,010 B |
| Difference | −660,400 B | −162,376 B |

These figures are from temporary Vite builds with the current dependency tree. At that checkpoint `pnpm build` still emitted the **normal Babel version**, not the pilot; this is historical evidence, not the current import routing. Re-run both commands to validate the result on another checkout; chunk hashes and sizes may vary with toolchain updates.

## Evidence and limits

The differential matrix uncovered a concrete mismatch: when a condition contained a nested ternary, the pilot generated the outer branch label **after** injecting an inner `__trace.branch(...)` call. It now freezes all original labels before rewriting conditions; the failing expression is kept in the edge-case matrix. The syntax matrix also found that the pilot rejected a functionless source in direct instrumentation while Babel accepted it; the pilot now matches Babel on that edge (source analysis still determines when a pasted source should run as a script). The generator checks that every chosen condition, body variant, and input length is exercised. An additional 75-case cross product covers five loop forms, five statement bodies, and three input lengths. Twelve targeted runtime cases cover modern syntax including accessors: these exposed a real pilot mismatch where getter/setter calls were labeled by property name rather than Babel's `anonymous`; the pilot now matches the reference. The expanded syntax matrix probes Unicode identifiers, modern expressions, async iteration, hashbangs, and invalid bindings without assuming parser error wording matches.

**Not a language-wide drop-in compatibility guarantee.** Finite differential tests establish parity only for the cases and environment above, not for arbitrary JavaScript. The current working-tree production build uses the integrated core; the historical build above used Babel. The finite corpus, 14 browser Worker pairs, and three app-level pairs still cannot establish arbitrary-JavaScript equivalence, full parser/diagnostic coverage, behavior beyond the finite three-engine corpus, or security. `eval` can bypass iteration guards; Chrome and Edge confirmed the app timeout terminates that Worker and a later run succeeds. The Worker is **not a security sandbox**: locally shadowing `globalThis` and `fetch` does not prevent code from reaching browser globals, including network-capable APIs (the probe does not make network requests). Never treat untrusted code as isolated merely because this probe passes. That earlier experiment did not substitute production imports; the current controlled integration does. The isolated size numbers are measurements, not a release claim.
