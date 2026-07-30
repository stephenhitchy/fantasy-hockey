# RinkRat Fantasy

The consolidated project context, update history, setup guidance, and historical test checklists are in:

- [`docs/RINKRAT_PROJECT_DOCUMENTATION.md`](docs/RINKRAT_PROJECT_DOCUMENTATION.md)

## Standard verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm ci
npm --prefix functions ci
npm run verify:batch6c
```

The Batch 6C verification runs the approved security, build, authority, Game Center, and documentation-cleanliness suites. The retired live browser workflow is no longer part of the verification command.
