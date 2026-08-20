# Operations Batch O1E — Tester Research and Milestone Surveys

**Runtime release:** Release Candidate 55
**Competitive models:** Production Scoring V4 and Projection V11
**Deployment order:** Functions first, then Hosting
**Data boundary:** Server-owned, privacy-limited private-season research

## Purpose

O1E turns the 2026–27 tester-season interview calendar into a repeatable evidence system. It does not attempt to prove product-market fit automatically. It gives tracked managers short surveys at the exact milestones defined in the Public Launch and Growth Gameplan and gives the platform administrator one privacy-limited dashboard for coverage, structured ratings, and qualitative themes.

The seven milestone surveys are:

1. **After joining** — “What did you expect to happen next?”
2. **After the Draft** — “Could your league run this without Stephen?”
3. **After the first matchup** — “Explain the six-game system in your own words.”
4. **After the first transaction** — “What made you confident the move worked?”
5. **Week 4** — “What brings you back? What do you still use elsewhere?”
6. **Midseason** — “What would make you quit?”
7. **End of season** — “Would you choose RinkRat next year? Why or why not?”

O1E supports the roadmap’s O1.21 research requirement. Live interviews, commissioner observation, churn interviews, and the full-season postmortem remain separate human research obligations.

## Manager experience

A signed-in verified manager can open:

```text
/private-season/feedback
```

The page lists only tracked private-season leagues in which that account is a real member. Milestones unlock from server evidence rather than browser checkboxes:

| Milestone | Server evidence required |
|---|---|
| After joining | Verified membership in an active tracked league |
| After Draft | Authoritative Draft status is complete |
| After first matchup | O1C recorded that this manager successfully loaded their live Game Center matchup |
| After first transaction | This manager owns a supported authoritative roster or waiver action in the league transaction record |
| Week 4 | 28 days have elapsed after league activation |
| Midseason | January 4, 2027 or later |
| End of season | April 11, 2027 or later, or the private-season plan is complete |

A response may be revised. The server requires the exact stored revision so a stale browser cannot silently overwrite a newer response.

### Structured evidence

Each response may include:

- clarity rating from 1–5;
- trust rating from 1–5;
- amount of information: too little, about right, or too much;
- whether the league could operate without Stephen;
- support frequency;
- next-season intent at the later milestones;
- recommendation score at midseason or season end;
- the milestone response;
- biggest friction;
- most useful feature or moment;
- willingness to participate in a later follow-up interview.

The page remains inline and mobile-first. It introduces no modal, fuzzy backdrop, fixed panel, or sticky survey control.

## Privacy boundary

No email address, phone number, or raw account ID is stored with a research response.

The server derives:

- authenticated account identity;
- verified-email status;
- tracked-league membership;
- league role;
- milestone eligibility;
- a deterministic response ID;
- a league-specific pseudonymous manager hash.

The browser cannot submit another manager’s account ID or choose the stored manager hash. Free-text fields reject email-address and phone-number patterns and are bounded. Managers are instructed not to enter names, medical details, or private incident evidence.

Research responses are stored under:

```text
platformOperations/privateSeason2026-27/researchResponses/{responseId}
```

The response ID and manager hash are pseudonymous, not anonymous. Platform administrators may review the privacy-limited qualitative response through the admin dashboard, but ordinary commissioners and managers cannot read another manager’s response.

Permanent account deletion removes the account-derived private-season research responses from every tracked tester league while preserving other testers’ evidence.

## Administrator dashboard

Platform administrators can open:

```text
/admin/private-season/research
```

The dashboard reports:

- total responses;
- league-manager respondent count;
- average clarity and trust;
- average recommendation score;
- information-load distribution;
- founder-independence percentage;
- recurring-support percentage;
- positive next-season intent;
- milestone response coverage;
- league-by-league research coverage;
- privacy-limited qualitative responses.

The administrator can filter by league, milestone, follow-up willingness, and response text. One person participating in two tester leagues counts as two league-manager respondents because every pseudonymous manager hash is intentionally league-specific. The copy-summary and CSV export actions contain no raw user ID, email address, or phone number.

A response-coverage percentage is evidence of collection only. A green percentage does not mean the underlying product result is positive. Read the ratings and qualitative responses, then conduct live interviews where the evidence is unclear or contradictory.

## Authority and abuse controls

The three callable Functions are:

```text
getPrivateSeasonResearch
submitPrivateSeasonResearch
getPrivateSeasonResearchDashboard
```

Manager submission requires:

- authentication;
- verified email;
- membership in an active O1B tester league;
- exact RC55 / Scoring V4 / Projection V11 build identity;
- a deployed build rather than a local build;
- server-confirmed milestone eligibility;
- the expected response revision;
- bounded valid response data;
- the daily research-update limit.

The administrator dashboard requires platform-administrator authority. O1E adds no browser Firestore write and requires no new Firestore Rule, index, TTL policy, or migration.

## Competitive boundaries

O1E changes no competition behavior. It does not modify:

- Production Scoring V4;
- legacy Scoring V3 reconstruction;
- Projection V11 calculations;
- immutable six-game roster-slot windows;
- seventh-game rollover;
- frozen window projections;
- Draft, roster, waiver, transaction, scoring, standings, or playoff authority;
- App Check Monitor mode;
- exact-league/callable canary controls;
- scoring queue Shadow mode;
- shared NHL-cache Shadow mode.

Submitting or reviewing research cannot change a league, unlock an action, approve the private season, close an incident, or promote infrastructure authority.

## Verification

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

node --version
npm --version

git restore -- public/assets/team-identity-logos

npm run verify:batcho1e
```

Expected versions:

```text
v22.23.1
11.17.0
```

## Deployment

Deploy the new research Functions and the maintained exact-build operations Functions before Hosting:

```bash
firebase deploy \
  --only functions:getPrivateSeasonResearch,functions:submitPrivateSeasonResearch,functions:getPrivateSeasonResearchDashboard,functions:getPrivateSeasonControlCenter,functions:updatePrivateSeasonPlan,functions:recordPrivateSeasonGateDecision,functions:recordPrivateSeasonEngagement,functions:getPrivateSeasonHealthDashboard,functions:updatePrivateSeasonWeeklyHealth,functions:getPublicServiceStatus,functions:getServiceIncidentOperations,functions:createServiceIncident,functions:updateServiceIncident,functions:deleteMyAccount \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1E tester research and RC55 authority"
```

Then deploy Hosting:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1E Tester Research Release Candidate 55"
```

Do not include Firestore Rules, indexes, TTL configuration, App Check settings, scoring-queue configuration, or NHL-cache authority in this deployment.

## Site proof

### Manager proof

1. Use a verified account belonging to a tracked O1B league.
2. Open `/private-season/feedback`.
3. Confirm After Joining is available.
4. Confirm later milestones remain locked until their authoritative evidence exists.
5. Submit a response without contact details.
6. Refresh and confirm it persists.
7. Revise the response and confirm the revision increases.
8. Attempt to enter an email address or phone number and confirm submission is blocked.
9. Use an untracked account and confirm no tracked league is exposed.

### Administrator proof

1. Open `/admin/private-season/research` with the platform-administrator account.
2. Confirm the response appears under the correct tracked league and milestone.
3. Confirm no email address, phone number, or raw account ID appears.
4. Confirm milestone and league coverage update.
5. Test the filters, summary copy, and CSV export.
6. Confirm an ordinary manager cannot access the route.

### Research interpretation

Use survey evidence to select live interview subjects and questions. Do not replace observation with forms. The full-season conclusion must combine:

- quantitative O1C health evidence;
- O1D incident evidence;
- O1E milestone surveys;
- observed Drafts and live play;
- direct manager and commissioner interviews;
- support records;
- the final full-season postmortem.


## O1E.1 release-verification correction

O1E.1 changes no tester-research behavior or runtime asset. It fixes the inherited competition-design audit used by the GitHub security and release workflow. The current Unified Add / Drop and Player Board page remains intact; the audit now imports the same reviewed successor contract as its regression test and explicitly reruns under `npm run verify:batcho1e`. See `docs/RINKRAT_OPERATIONS_O1E_1_COMPETITION_DESIGN_AUDIT.md`.
