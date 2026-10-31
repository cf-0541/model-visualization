# Frozen Babel AST reference

These three files preserve the working-tree Babel implementations immediately before controlled integration on 2026-10-31. Only comments and type-only import paths were adjusted when archiving them. The lockfile pins the reference dependencies; normal application modules must never import this directory.

The differential harness bundles these files independently. Application-build comparisons redirect only the reference build to these files; the integrated production build must use its unchanged imports. Both variants intentionally share the current trace runtime and Worker: this gate isolates AST/input-analysis changes, not a comparison to a historical released runtime.

Do not replace the reference with re-exports of production or edit it just to erase a failing comparison. A deliberate behavior change needs an explicit contract/test decision. Babel remains a development dependency for this reference and build tooling, not an application runtime fallback.
