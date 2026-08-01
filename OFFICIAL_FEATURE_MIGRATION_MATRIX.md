# Official Feature Migration Traceability Matrix

## Verified Baseline

- Target baseline: `320795b4fc88c2faf410b7f1883eb0e7b686910c` (`origin/main` at fetch time).
- Development branch/worktree: `dev` in `Sillytarven-online-dev`.
- Official boundaries verified from tags:
  - `1.15.0`: `1c0e7ea9556afcc3ae55c888287dff67a6aa42fc`
  - `1.16.0`: `e3b866b5d2bcc7fbaa889bb926fbb567cd1ed25b`
  - `1.17.0`: `e3f41666c69db032e17e079fcddcf40cf47e8593`
  - `1.18.0`: `51ad27fb86d39a3daca3adaa970375c9670c12df`
- Official range counts verified with `git log`: 148 commits in `(1.15,1.16]`, 136 in `(1.16,1.17]`, 107 in `(1.17,1.18]`.
- Evidence method: `git show`, `git diff-tree`, `git cat-file`, and `git grep <tree>` against official Git objects. The dirty official worktree was not used or modified.
- Status values: `planned` means source evidence is verified but implementation has not yet been committed. Rows are updated with tests and commit/push hashes as work lands.

## Cross-Cutting Storage Preconditions

| Feature point | Official/source evidence | Target state at baseline | Conflict/risk | Adaptation | Tests | Commit/push |
|---|---|---|---|---|---|---|
| Durable chat transaction | Target `src/endpoints/chats.js`: `createChatWriteSnapshot`, `writeChunkedChat`, `truncateChunkedChat`, `appendChunkedMessages` | Version-2 journal has durable `prepared`, `mutating`, and `committed` states; router recovery is scoped to the authenticated user | Crash can expose partial shard/index/header/metadata/revision state | Journal namespace is `path.join(path.dirname(userRoot), '.migration-journals', sha256(handle))`; manifests store only user-root-relative targets and enforce root/handle fingerprints, artifact families, regular files, and no symlinks | Real child-process crashes cover `mutating` rollback and committed-marker cleanup; prepared recovery, malicious target/artifact manifests, symlink rejection, and A/B router isolation are also covered | phase 0 implemented (uncommitted) |
| Chat artifact contract | Target constants and `listChatArtifactPaths()` | Main `.jsonl`, `.metadata.json`, `.index.json`, `.revision.json`, and `.chunks/` are snapshotted as one unit, including empty chunk-directory presence | Specs omitted `.revision.json` | Treat all five as one unit; preserve legacy readers | Five-part child-process recovery plus canonical legacy/chunk-like manifests at counts 0/1/199/200/299/300/301/1000 | phase 0 implemented (uncommitted) |
| Canonical snapshot/hash | No complete official equivalent; required by migration specification | Canonical JSON, SHA-256, deterministic file manifests, verification, and in-memory dry-run snapshot/diff APIs are implemented | Unknown JSON fields or byte-stable message lines may be lost silently | Recursive key ordering for JSON; byte hashes for artifacts; pure dry-run diff reports JSON, file, and directory changes | `canonical-hash.node.test.mjs` and `canonical-snapshot-fixtures.node.test.mjs` verify unknown fields, canonical before/after values, raw legacy message bytes, and unchanged shard/index hashes at all eight required counts | phase 0 implemented (uncommitted) |
| Feature gates | Requested migration contract; no single official commit | Five additive migration gates default false | Partial rollout cannot be isolated | Public boolean projection for `macros2`, `reasoningTools`, `extensionLifecycle`, `swipePicker`, and `worldInfoRelink` | Default config, one-at-a-time isolation, type, and public endpoint tests | phase 0 implemented (uncommitted) |
| Reliable browser test target | Target `tests/playwright.config.js` and `frontent-test-utils.js` previously hard-coded port 8000 | Both now resolve `ST_TEST_URL` with the existing URL as fallback | Tests can hit old code and time out selecting one account | Environment-driven base URL; worker policy unchanged in phase 0 | `playwright-url.node.test.mjs` verifies config and frontend setup projection; full browser conformance remains feature-phase work | phase 0 implemented (uncommitted) |

## Macros 2.0

`M` below means `public/scripts/macros`; `A` means `public/scripts/autocomplete`.

| Official commit / verified boundary | Official actual diff and behavior | Target state / conflict | Adaptation | Tests | Commit/push |
|---|---|---|---|---|---|
| `e9bedadc` `(1.15,1.16]` | CSS, autocomplete bases, core definitions, `MacroFlags`, lexer/parser/CST/engine/registry, power-user, slash parser, 5 test files; scoped macros, if/else, trim/dedent | Core files equal parent snapshot; `MacroFlags` absent | Port subsystem files; merge only integration hunks | Official engine/lexer/parser/registry/story tests | planned |
| `0dcd9906` `(1.15,1.16]` | `.local`/`$global`, conditional variables; CST/flags/lexer/parser/autocomplete/tests | Missing | Port final semantics | Variable isolation and condition tests | planned |
| `dbc4fe61` `(1.15,1.16]` | Case-insensitive registry, aliases, dynamic/scoped closing | Missing | Port final engine/registry | Case and alias tests | planned |
| `81414724` `(1.15,1.16]` | Delayed argument resolution and lazy branch handler `resolve()` | Missing | Port; preserve no-side-effect unselected branches | Lazy nested if tests | planned |
| `b453fdc5` `(1.15,1.16]` | Alias display, closing whitespace, move `M/MacroBrowser.js` to `M/engine` | Old path/import remains | Move and update imports without replacing cloud callers | Import/browser tests | planned |
| `7331dba0` `(1.15,1.16]` | Dynamic definitions; STscript closure/parser integration; `script.js` | Missing; `script.js` high conflict | Port engine and closure hunks only | Slash closure/dynamic tests | planned |
| `3047045d` `(1.15,1.16]` | Reparse scoped content/arguments with global offsets | Missing | Port final CST/engine | Nested scoped argument tests | planned |
| `5c2a02a1` `(1.15,1.16]` | Delayed pick inherits global offset | Missing | Port final engine/registry | Deterministic delayed pick tests | planned |
| `f8c373f5` `(1.15,1.16]` | Operators, lazy fallback, has/delete variables; `st-context`/`variables` API | Missing | Port and expose `has` without changing user scope keys | Local/global multi-user tests | planned |
| `0b529290` `(1.15,1.16]` | Runtime warning context | Missing | Port | Warning argument tests | planned |
| `42155ece` `(1.15,1.16]` | Numeric comparison and autocomplete | Missing | Port | Operator tests | planned |
| `ca60ba14` `(1.15,1.16]` | Independent alias registration/public API | Missing | Port | Alias-of-alias tests | planned |
| `06b77ec9` `(1.15,1.16]` | Autocomplete cursor/operator/value boundaries | Helper absent | Port final autocomplete | Browser autocomplete tests | planned |
| `9f444997` `(1.15,1.16]` | Optional scope, nested closing completion | Missing | Port final autocomplete/CST | Scope completion tests | planned |
| `953d9f34` `(1.15,1.16]` | List min/max validation and completion | Missing | Port | Arity/list tests | planned |
| `cd0627bf` `(1.15,1.16]` | Shared `findExtension()` and `hasExtension` | Missing; cloud local/global shadow exists | Use canonical resolver from lifecycle work | Resolver and macro tests | planned |
| `e40b31b0` `(1.15,1.16]` | Detect new syntax and offer engine opt-in | Missing | Merge diagnostics/UI only | Legacy opt-in test | planned |
| `281c50bb` `(1.15,1.16]` | Initialize macros before extensions | Target initializes extensions first | Reorder while preserving preload and async startup | Initialization order test | planned |
| `c705cbe6` `(1.15,1.16]` | Removes duplicate env `summary` registration | Target still has duplicate env + memory registration | Remove duplicate after lifecycle order is deterministic | Memory summary precedence test | planned |
| `61891853` `(1.15,1.16]` | Reload prompt after engine toggle | Missing | Port without rewriting saved value | Existing-user setting preservation | planned |
| `26d495f4` `(1.15,1.16]` | `/reroll-pick`, optional `pick_reroll_seed` | Missing | Add optional field only | Seed/reroll tests | planned |
| `9ff9d596` `(1.15,1.16]` | Global `data-macros`, observer and autocomplete modules | Missing; HTML/script/style high conflict | Attribute/function-level integration | Input/autocomplete E2E | planned |
| `bee4d9a8` `(1.15,1.16]` | Avoid pristine greeting swipe overwrite | Missing; paged chat state differs | Merge into cloud swipe save path | Legacy greeting macro test | planned |
| `eeda4d37` `(1.16,1.17]` | Context/response/prompt token APIs/macros | Missing | Preserve prompt dry-run scheduler | Max-token tests | planned |
| `b5a1d227` `(1.16,1.17]` | Lazy greeting/alternate greeting macros | Missing | Merge logical-message lookup for paging | Greeting index tests | planned |
| `f5b1f913` `(1.16,1.17]` | New install default enables engine | Target default false | Preserve existing values; gate/admin template policy for new users | Old/new settings fixtures | planned |
| `8879272a` `(1.16,1.17]` | Summary prefers current memory UI | Missing | Port into lifecycle-exported init | Summary tests | planned |
| `ff4c6fa1` `(1.17,1.18]` | Legacy macro warnings include call arguments | Missing | Port | Warning test | planned |
| `aec9754b` `>1.18 staging` | Scoped comment closing and six tests | Missing | Backport verified fix | Six comment regressions | planned |
| `355598bb` `>1.18 staging` | Disables pipe token and skips output-filter suite; it does not implement pipe parsing | Target has active incomplete pipe token | Preserve literal `|` argument behavior; do not claim filters | Literal/escaped pipe tests; skipped filter capability documented | planned |
| `93bd9e21` `>1.18 staging` | Variable key/index APIs | Missing | Add only if variable API supports keyed access safely | Key/index tests | planned |
| `2463e839` `>1.18 staging` | Source whitespace-only change | No behavior to migrate | Excluded | N/A | verified exclusion |
| `8372e7bf` `(1.15,1.16]` | 44-file mechanical dot-notation refactor plus unrelated guards | Not a semantic dependency | Excluded from migration | N/A | verified exclusion |

## Reasoning, Tool Calling, Streaming Errors

| Official commit / boundary | Official actual diff and behavior | Target state / conflict | Adaptation | Tests | Commit/push |
|---|---|---|---|---|---|
| `06691e8b` `(1.15,1.16]` | Gemini thought-signature config/converter | Missing | Add optional config default true and converter guard | Signature on/off | planned |
| `97143747` `(1.15,1.16]` | Preserve original user input during tool recursion | Missing | Merge around cloud save/event sequence | Recursive input and MESSAGE_SENT | planned |
| `0ba0418f` `(1.16,1.17]` | Three tool reasoning modes across UI/script/openai/reasoning/tools/locales | Missing | Default disabled; merge function-level | OpenRouter modes | planned |
| `0cef10f6` `(1.16,1.17]` | Explicit OpenRouter reasoning exclusion when hidden | Missing | Port request semantics | `show_thoughts=false` | planned |
| `15e2f240` `(1.16,1.17]` | Cache-at-depth skips system message | Missing | Port converter guard | Cache depth test | planned |
| `63fa9c1d`,`3070cf26`,`b259c975` `(1.16,1.17]` | Claude adaptive mapping/config/final default false | Missing | Add opt-in false path | Adaptive/budget multipart matrix | planned |
| `9bce79f7` `(1.16,1.17]` | Concatenate non-stream multipart text/thinking | Missing | Port parser | Multi-text/thinking/tool response | planned |
| `c3f36b2b` `(1.16,1.17]` | OpenRouter signature respects config | Missing | Port and clean cross-provider signature | Provider switch tests | planned |
| `94139f46` `(1.16,1.17]` | Lightweight intermediary finalization | Missing; cloud has pending rAF buffer | Cancel pending frame then render final state before event/save-tail | Intermediary/rAF ordering | planned |
| `b8929341` `(1.17,1.18]` | Preserve Error and write `error:true` invocation | Missing | Port stable failure protocol | Throw/empty/stealth failures | planned |
| `c9c652ee` `(1.17,1.18]` | Awaitable non-2xx response forwarding in seven backend/middleware files and util tests | Current forwarder synchronous; abort listeners already improved | Port async body forwarding, keep `response.once(close)` | 403 JSON, 502 text, 401, SSE, abort | planned |
| `f4f390f3` `(1.17,1.18]` | Custom stream state includes images/signatures/tool signatures | Missing | Port | Custom streaming state | planned |
| `051346c5` `(1.17,1.18]` | Custom OpenAI interleaved reasoning | Missing | Extend provider set safely | Custom modes | planned |
| `552936a0` `(1.17,1.18]` | Filter other group characters' reasoning/signatures | Missing | Merge in cloud group wrapper | Group A/B/C isolation | planned |
| `7948886c` `(1.17,1.18]` | Configurable recurse limit, default 5 | Fixed constant only | User 1..50, instance hard cap, effective min | 1/5/hard-cap tests | planned |
| `940b3722` `(1.17,1.18]` | Empty/pure-tool cache tail guard | Missing | Port | Empty content tests | planned |
| `338e35fc` `(1.17,1.18]` | Custom JSON Schema normal/stream/quiet/group | Backend partial; stream/group argument missing | Complete all call paths | Four-path schema matrix | planned |

## Extension Manifest Lifecycle

| Official commit / boundary | Official actual diff and behavior | Target state / conflict | Adaptation | Tests | Commit/push |
|---|---|---|---|---|---|
| `cd0627bf` `(1.15,1.16]` | Shared extension lookup | Missing | Canonical `{canonicalName,type,manifest,resourceBaseUrl}` resolver | builtin/local/global/shadow | planned |
| `3ad9b05e` `(1.16,1.17]` | install/update/delete/enable/disable/activate hooks; 5s race | Missing; official short-name import can hit local shadow | Typed resolver and standardized hook result; timeout/dedupe | Sync/async/reject/timeout/missing export | planned |
| `f3521e70` `(1.17,1.18]` | `script.js` awaits init; 14 builtin `index.js + manifest` pairs | All 14 self-start and have no activate hook | Migrate in small batches, one init only | Per-extension init count | planned |
| `a7f144f2` `(1.17,1.18]` | Expose cloned manifest through context | Missing | Structured clone from canonical resolver | Mutation isolation | planned |
| `737cb95a` `(1.17,1.18]` | Clean hook/UI/delete-clean | Missing; official timeout does not cancel | Current-user-only clean, explicit status | Clean/delete order and isolation | planned |
| `5512473b` `(1.17,1.18]` | Source/URL/flag/install warning and endpoint changes | Partial cloud management | Merge required guards without replacing admin UI | Install/update/source tests | planned |
| `3eb38615` `(1.17,1.18]` | Invalid clone cleanup and route guard | Route guard partial | Fill validation/cleanup | Invalid manifest/cleanup | planned |
| `97392a4c` `(1.17,1.18]` | Management panel refactor | Not a lifecycle dependency | Excluded unless required by behavior | N/A | verified exclusion |
| `992fd8f0` `(1.15,1.16]` | Bulk extension toggle | Target already has selected behavior | Keep existing cloud behavior | Existing regression | preserve |
| Cloud passive preload | Target `extension-resource-preload.js` uses `modulepreload` | Verified passive and covered by 5 tests | Keep discover -> manifest -> preload hint -> module -> active -> hook -> dispose | Existing 5 plus hook order | planned |
| 14 builtins | assets, attachments, caption, connection-manager, expressions, gallery, memory, quick-reply, regex, stable-diffusion, token-counter, translate, tts, vectors | jQuery ready/IIFE/top-level await self-start | Export idempotent `init`; add manifest activate in same commit | DOM/event/slash/worker/network once | planned |

## Swipe Picker

| Official commit / verified boundary | Official actual diff and behavior | Target state / conflict | Adaptation | Tests | Commit/push |
|---|---|---|---|---|---|
| `bf91d9af` `(1.15,1.16]` | Extracts long-press helper for World Info; not Picker UI | Helper missing | Implement once for Picker and World Info | Pointer cancel/long press | planned |
| `b04c9744` `(1.15,1.16]` | Picker UI/read/select/delete/branch; branches from `chat.slice(0,mesId+1)` | Picker absent; target chat is paged suffix | Port UI only; server is source of branch history | Read/jump/delete first | planned |
| `63feac94` `(1.16,1.17]` | One label change (`Swipes:` -> `Swipe #`) | Absent | Included in final UI; not treated as core | Display test | planned |
| `d2b2b1b4` `(1.17,1.18]` | Long-press opening and visual progress | Absent | Pointer-safe mobile long press | Mobile E2E | planned |
| Related swipe/greeting/command commits | Actual inspected changes are ordinary swipe/greeting/command behavior, not transactional branching | Existing behavior varies | Merge only proven prerequisites during integration | Regression tests | planned |
| Solo `/get-range` | Target returns header/messages/cursor/hasMore/revision | Missing messageOffset/total; legacy cursor is byte offset | Add absolute offset/total; server revalidates index | Legacy/chunked range matrix | planned |
| Group `/get-range` | Target already returns messageOffset/total/revision | Embedded-header offsets differ | Preserve opaque cursor and server index mapping | Embedded header tests | planned |
| Server branch API | No official server equivalent | Current solo branch saves local slice; group full-load workaround | Locked/revisioned source read, validate swipe, atomically write destination, update source only after success | Solo/group, legacy/chunked, tail-only, cross-shard, 500 swipes, fault injection | planned |

## World Info Rename Relink

| Official commit / verified boundary | Official actual diff and behavior | Target state / conflict | Adaptation | Tests | Commit/push |
|---|---|---|---|---|---|
| `bf91d9af` `(1.15,1.16]` | Common long-press and World Info UI refactor | Missing | Share helper with Picker | Desktop/mobile controls | planned |
| `a794a378` `(1.17,1.18]` | Main/auxiliary character links and `toShallow()` world; client prompts/saves | Target only updates `charLore.extraBooks`; shallow main world missing | Add shallow field, but use server plan/transaction | Shallow/full cards | planned |
| `d5b6b792` `>1.18 staging` | Current chat metadata relink and one UI test | Missing; does not scan history | Scan all solo/group headers server-side | Current/history tests | planned |
| `44af6bc1` `>1.18 staging` | Persona references and one UI test | Missing | Include all personas in one settings transaction | Current/other persona | planned |
| Official rename order | Save new -> delete old -> ask/update references | Can leave dangling links; no rollback | Plan/journal/commit/status/rollback; keep old until verification | Reject/failure/crash/rollback | planned |
| Chunked header update | Target reads `.metadata.json` before main header; revision sidecar exists | Specs omitted sidecar/revision | Update main+metadata+revision only; preserve index/shards byte hashes | Full hash invariant | planned |
| Legacy header update | First JSONL line plus possible metadata/revision | Rewriting full file can alter message bytes | Atomic first-line replacement preserving remaining bytes | Byte-for-byte message lines | planned |
| Cache/quota/isolation | settings/character/recent/chat-info caches and per-user roots | Current rename relies on separate route effects | Explicit per-handle invalidation; journal outside user quota; bounded PNG writes | A/B users, quota, cache tests | planned |

## Baseline Test Record

| Command | Runtime | Result |
|---|---|---|
| `npm run test:phase0` | Node 22.13.1 | 34 passed, 0 failed, 0 skipped |
| `npm run test:optimizations` after phase 0 | Node 22.13.1 | 91 passed, 0 failed, 0 skipped |
| `npm run test:imports` after phase 0 | Node 22.13.1 | 34 passed, 0 failed, 0 skipped |
| Focused ESLint on changed phase-0 server files | Node 22.13.1, ESLint 8.57.1 | 0 errors, 0 warnings |
| Focused ESLint on changed phase-0 and chat fixture test files | Node 22.13.1, ESLint 8.57.1 | 0 errors, 0 warnings |
| `npm run lint -- --no-cache` | ESLint 8.57.1 | Earlier phase-0 run found 339 pre-existing errors in unrelated files; not rerun for this review because requested focused lint is clean |
| `npm run test:optimizations` | Node 24.11.1 | 91 passed, 0 failed, 0 skipped |
| `npm run test:imports` | Node 24.11.1 | 34 passed, 0 failed |
| `npm run test:user-invitations` | Node 24.11.1 | 3 passed, 0 failed, 7 skipped because invitation codes are disabled in test config |
| `npm run test:registration` | Node 24.11.1 | Process-level failure after 11 assertions; Node runtime exited abnormally |
| Direct registration test | Node 22.13.1 | 14 passed, 0 failed |
| `tests npm run test:unit -- --runInBand` | Node 24.11.1 | 5 passed, 1 failed: browser-only `sample.test.js` included by Jest and `page` is undefined |
| Existing macro Playwright files against hard-coded port 8000 | Playwright 1.56.1 | 87 passed, 84 failed; failures include shared-login timeouts and assertions hitting an older server process. Not an isolated valid conformance result. |
| Isolated server startup | Node 22.13.1, port 8011 | HTTP 200; webpack compile successful |

Node 24.11.1 also exits with Windows status `3221226505` while importing/running `post-install.js`; Node 22.13.1 completes the same script. Migration validation therefore uses Node 22 unless a test explicitly checks a newer runtime.

## Verified Documentation Corrections

1. The source document baselines `d3f17c2`; fetch-time `origin/main` is `320795b4fc88c2faf410b7f1883eb0e7b686910c`.
2. The listed commit tables are dependency sets, not linear cherry-pick chains.
3. Swipe Picker core `b04c9744` is in the 1.16 boundary; `63feac94` only changes a label.
4. `bf91d9af` is a World Info/long-press refactor, not the Picker core.
5. `355598bb` disables unfinished output filters; it does not implement a selective pipe parser fix.
6. `2463e839` is source whitespace only, not output whitespace behavior.
7. Macro static test counts are 172 at target baseline and 512 at official 1.18 for the named files, not 171/511; staging fixes raise the set further.
8. `forwardFetchResponse` has no verified target-side 401-only clone optimization; the document's claim is not present in source.
9. Official lifecycle commits add no lifecycle automation; the required hook tests must be authored here.
10. The target chat transaction includes `.revision.json`, omitted from the source documents.
11. At baseline, runtime chat snapshots recover thrown errors but not process crashes; phase 0 adds durable pre-access recovery.
12. World Info chat/persona relink commits are post-1.18 staging, cover only current chat/personas, and remain non-transactional.
