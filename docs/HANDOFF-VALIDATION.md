# Repository handoff verification

Verified on October 21, 2026 for the GitHub handoff. The clean-checkout run used source commit `a0a770606a7de1e9611540f63f361bed6a83c1d3`; subsequent handoff changes contain documentation only.

Environment: macOS arm64, Node.js 24.19.0, pnpm 11.25.0. This is local development verification, not Ally acceptance.

| Check | Observed result |
| --- | --- |
| Fresh Git clone without the original `.local/`, `.env`, dependencies or private trial files | Created successfully from the committed source |
| `pnpm install --frozen-lockfile` in that clone | Passed; 226 packages reused from the local package cache, no lockfile regeneration |
| `pnpm test` from the fresh clone | **1,203 passed, 0 failed, 0 skipped**; approximately 45.4 seconds in this run |
| Offline service/console | Loopback `/health` reported local/rules; console HTML served successfully |
| Offline CLI | Synthetic `seed recent-regression`, `status`, and simulated Teams `incidents` returned successful JSON; investigation tick completed |
| Strict configuration readiness | Passed for a copied connected template with rules selected, all integrations/writers disabled, unused custom webhook references removed, and temporary core secrets supplied only to the subprocess environment; report recorded zero network calls and `liveValidated:false` |
| Documentation | Repository-relative Markdown links and anchors checked against the checkout |
| Publication exclusions | Tracked-file inventory checked for private/generated directories, environment files other than `.env.example`, large artifacts and common credential/key prefixes; no matches found |
| Whitespace | `git diff --check` passed before commit |

The fresh-clone attempt initially exposed concurrent first-time creation of the shared synthetic auction repository. `scripts/run-tests.mjs` now finishes seeding that fixture before starting parallel test processes. `pnpm test` and the README's direct Node command both use this entry point. The successful full-suite run above started without a preexisting generated auction fixture.

The offline smoke service and its owned listener were closed after verification. Logs, inventories and synthetic databases remain in the ignored `.local/repository-handoff/` directory on the originating machine; they are not distributed with this repository.

No Ally provider access, enterprise Claude authentication, live Ally Teams installation, production database topology, container build, cloud deployment or real deployment execution was verified in this handoff. Use [the integration acceptance checklist](ALLY-INTEGRATION-CHECKLIST.md#acceptance-record-to-complete-in-ally) for the receiving environment. Dated earlier trial reports retain their own stated scope.
