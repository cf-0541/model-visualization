# AST runtime core

These ESM JavaScript modules are the tested Acorn/acorn-walk/Astring implementation promoted from the feasibility experiment. The adjacent `.d.mts` files define the public contracts consumed by the existing strict TypeScript API modules; AST rewriting internals remain JavaScript, not type-checked ESTree code. Do not weaken `tsconfig` or treat declarations as proof of implementation correctness.

Normal app imports go through `src/instrumentation/instrument.ts`, `src/sourceAnalysis.ts`, and `src/parseInput.ts`. Babel is development-only: its frozen reference is under `experiments/lightweight-ast/babel/`. Experiment compatibility entrypoints re-export this core so differential tests exercise the shipped implementation rather than a duplicate.

Run `pnpm test`, `pnpm pilot:ast`, `pnpm pilot:build`, `pnpm build`, and the three-engine `pnpm pilot:production-e2e` before changing the AST pipeline. The latter two pilot build commands assert independent module graphs: only the reference is aliased; normal production imports must contain all three cores and no Babel/experiment code. See the experiment README for the bounded language and trusted-code contract. Finite parity is not arbitrary-JavaScript equivalence or a hostile-code sandbox.
