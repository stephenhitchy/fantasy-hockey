# Operations Batch O1I.1 — TypeScript 6 Isolated Compile Hotfix

**Runtime release:** Release Candidate 59  
**Competitive models:** Production Scoring V4 · Projection V11  
**Operations API:** v1 unchanged  
**Deployment:** No runtime deployment for the hotfix itself; deploy RC59 Hosting when O1I has not yet been released.

## Failure

The O1I calculator regression compiled three scoring files by passing both compiler options and explicit source filenames directly to `tsc`.

TypeScript 6 reports TS5112 when a repository `tsconfig.json` is present and explicit source files are supplied on the command line without an explicit configuration decision. The failure occurred in the test harness before Firebase deployment and did not indicate a calculator, scoring, Angular, or Functions defect.

## Correction

The regression now writes a temporary isolated `tsconfig.json` and invokes:

```text
tsc --project <temporary-config>
```

The temporary project uses:

```text
Target: ES2022
Module: Node16
Module resolution: Node16
Strict checking: enabled
Skip library checking: enabled
Root: src/app/core/scoring
Files: scoring-rules.ts, scoring-engine.ts, public-scoring-calculator.util.ts
```

This preserves the intended semantic compile of the canonical scoring rules, scoring engine, and calculator utility while remaining compatible with TypeScript 6 project-mode requirements. It does not use `--ignoreConfig`, does not weaken strict checking, and does not change production source.

## Boundaries

O1I.1 changes no:

- browser runtime;
- Cloud Function;
- Production Scoring V4 value;
- Projection V11 calculation;
- six-game window or seventh-game rollover;
- Firestore Rule, index, or TTL policy;
- App Check, scoring-queue, or shared NHL-cache mode.

## Verification

```bash
npm run test:batcho1i:run
npm run verify:batcho1i
```

The O1I test suite now includes a source regression requiring the temporary TypeScript project and `--project` invocation.
