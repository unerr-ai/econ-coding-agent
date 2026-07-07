# tiny-cli-tool (fixture)

A small, deliberately test-poor fixture repo for the OL-7.12 everyday-capability
eval (`packages/eval`). It has source files and no test directory at all — the
verifier ladder for tasks against this repo cannot lean on a sound-test rung
and must fall back to QE / cross-model judge.

Do not add tests here — that would break the fixture's premise. If you need a
test-poor case that behaves differently, add a new fixture repo instead.

