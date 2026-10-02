---
'e2e': minor
---

Every run now writes a sealed `.evidence` pack, `<output>/evidence/<runId>.evidence`, in the open format `@testmuai/evidence-cli` defines: each test's source, steps, verdicts (`failed` for an assertion, `broken` for a check that could not decide), a frame per step, a failure record on the failing step, and logs, validated at the L1 profile. While it is on, `screenshot` defaults to `every-step`. Turn it off with `evidence: false`, `E2E_EVIDENCE=0`, or `--no-evidence`; `e2e init` adds `.e2e/evidence/` to `.gitignore`.
