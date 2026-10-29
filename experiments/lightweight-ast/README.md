# Lightweight AST feasibility pilot

The normal app still uses Babel. This Acorn + Astring experiment stays under `experiments/` and is never imported by a normal app build. Do **not** use the pilot's size result as a release claim.

## Reproduce

- `pnpm pilot:ast`: independently bundle the production Babel compiler, the Acorn pilot, and the real Worker runtime. Compare complete event/result snapshots on six bundled examples, 29 hand-written snippets, and **154 bounded differential cases** from fixed seed `0x5eed1234`. Also check nine paste → input → analysis → argument → trace workflows, a 26-source syntax/error-category matrix, five source-analysis error diagnostics, 26 input literal/error cases, and 15 responses from the bundled Worker **handler** invoked in Node with a structured-cloning `postMessage` stub. Parser wording/positions are not asserted equal; application-defined analysis errors are. Runs in CI.

- `pnpm pilot:browser`: run 13 paired cases through the actual bundled **module Worker in Chromium** via a loopback HTTP page and DevTools protocol. Covers sync mutation, generators, nested async, dynamic `import()` with a data URL, rejected promises, script failures, event/iteration caps and terminating a truly stuck Worker (`eval` bypasses instrumentation guards). Compares real `postMessage` responses, ignoring elapsed duration only. Requires local Chrome/Edge (or `CHROME_PATH`); this is an explicit local check, **not** part of CI, and never falls back to a Node mock. Uses a disposable browser profile and loopback server.
- `pnpm pilot:build`: make two temporary Vite app builds: one unchanged and one redirecting **instrumentation, source analysis, and input parsing** to the pilot. Compare the total raw/gzip size of **all emitted JavaScript**, including the worker. The temporary outputs are removed afterward; normal builds and the repository's `dist` are unaffected.

## Current isolated-build measurement

| Variant | All JS raw | All JS gzip |
| --- | ---: | ---: |
| Normal Babel build | 1,090,170 B | 300,179 B |
| Three-module pilot substitution | 429,753 B | 137,799 B |
| Difference | −660,417 B | −162,380 B |

These figures are from temporary Vite builds with the current dependency tree. `pnpm build` continues to emit the **normal Babel version**, not the pilot. Re-run both commands to validate the result on another checkout; chunk hashes and sizes may vary with toolchain updates.

## Evidence and limits

The differential matrix uncovered a concrete mismatch: when a condition contained a nested ternary, the pilot generated the outer branch label **after** injecting an inner `__trace.branch(...)` call. It now freezes all original labels before rewriting conditions; the failing expression is kept in the edge-case matrix. The syntax matrix also found that the pilot rejected a functionless source in direct instrumentation while Babel accepted it; the pilot now matches Babel on that edge (source analysis still determines when a pasted source should run as a script). The generator checks that every chosen condition, body variant, and input length is exercised.

**Not a drop-in replacement yet.** Finite differential tests establish parity only for the cases and environment above, not for arbitrary JavaScript. The production build still uses Babel. The finite corpus and 13 browser cases still cannot establish arbitrary-JavaScript equivalence, full parser/diagnostic coverage, cross-browser behavior, or security. `eval` can bypass iteration guards; the app relies on Worker timeout/termination for that case. No production substitution was made. The isolated size numbers are measurements, not a release claim.
