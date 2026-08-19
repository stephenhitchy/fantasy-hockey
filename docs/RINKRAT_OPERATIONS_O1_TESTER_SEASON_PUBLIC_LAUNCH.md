# Operations Phase O1 — Tester Season and Public-Launch Foundation

**Planning source:** RinkRat Public Launch & Growth Gameplan, August 18, 2026
**Private proof season:** 2026–27
**Potential commissioner-first public season:** 2027–28
**Product principle:** activated and retained leagues matter; raw signups and views do not

## Purpose

The launch gameplan identifies RinkRat's remaining public-growth gap as trust, live-season proof, support, abuse resistance, legal/data readiness, retention, and proven scale—not lack of feature breadth. Phase O1 converts those business and operating requirements into permanent product and engineering tasks.

This runbook is a product/operations backlog. It is not legal, tax, gaming, insurance, or licensing advice. Written professional review remains a launch gate where the gameplan requires it.

## Tester-season cohort

The proof cohort should contain:

```text
2–4 leagues
10–30 observed managers
at least one commissioner other than Stephen
hockey experts
casual fans
fantasy beginners
iPhone users
Android users
desktop users
```

Each manager should have a tester archetype and a support contact path. The season is not considered self-service proof when Stephen must explain every Draft, transaction, or six-game rule.

## Product gates that must exist

### Integrity and action evidence

RinkRat must be able to report:

- unresolved P0 competition-integrity defects;
- confirmed Draft, roster, waiver, IR, and commissioner action success;
- ambiguous or lost-response outcomes;
- scoring freshness and queue backlog;
- six-game and seventh-game invariant failures;
- support minutes per active league;
- release, browser, device, and App Check context.

Green launch targets from the gameplan are:

```text
0 unresolved P0 integrity defects
at least 99.5% confirmed core-action reliability
at least 75% Draft completion among leagues reaching six managers
at least 60% of created leagues reaching six verified managers
at least 70% four-week retention
median support below 20 minutes per active league per week
at least 70% commissioner/tester next-season intent
```

These are internal operating targets, not industry guarantees.

### League activation funnel

The permanent analytics model should measure, with data minimization and consent-aware attribution:

```text
qualified visit
commissioner lead or waitlist
account created
league created
six verified members
Draft completed
first matchup viewed
first roster action
four-week retained league
commissioner return intent
manager-to-commissioner conversion
support minutes
cost per activated and retained league
```

Acquisition source should distinguish organic, commissioner referral, creator, community, local event, paid search, and paid social. Rewards must be based on activated leagues rather than clicks or raw invitations.

### Commissioner self-service

Before public acquisition, a non-founder commissioner must be able to:

- create and configure a league;
- understand the six-game model;
- invite and follow up with managers;
- schedule and complete a Draft;
- handle common Draft recovery;
- understand waivers, IR, and roster timing;
- access concise support and incident information;
- run the league without founder-only Firestore or administrator intervention.

Needed public materials include a commissioner FAQ, Draft-night checklist, setup walkthrough, rulebook, demo league, and support path.

### Support and incidents

Prepare:

- P0/P1/P2/P3 severity definitions;
- covered support hours and realistic response targets;
- a known-issues page;
- status and incident templates;
- an evidence-preserving no-silent-score-edit policy;
- rollback and data-recovery rehearsal;
- a deputy communication plan when Stephen is unavailable;
- a post-incident review template;
- support-minute measurement and hiring triggers.

### Legal, IP, data, and geography

Before unrestricted promotion or monetization, the gameplan requires written resolution of:

- the RinkRat name and trademark risk;
- NHL/team marks, logos, player imagery, clips, music, and marketing artwork;
- every sports-data/API source, terms, attribution, rate limit, cache, commercial right, continuity plan, and fallback;
- Terms, Privacy Policy, acceptable use, community rules, age policy, retention, deletion, export, and consent practices;
- initial geography and privacy-law obligations;
- entity, bookkeeping, licenses, insurance, and tax operations;
- real-money fantasy, paid entry, pooled prize, or league-dues custody restrictions.

The initial public model remains 18+, free core, no pooled league money, and no pay-to-win competitive advantage unless specialized review later approves another model.

### Abuse, moderation, and communications

Before public discovery or full chat, build:

- report and block;
- commissioner and platform moderation queues;
- appeal and evidence-retention procedure;
- immutable moderation audit history;
- community conduct rules;
- creator-league conduct expectations.

Email/waitlist operations need consent, truthful sender information, a postal address where legally required, unsubscribe handling, a suppression list, segmentation, and retention limits. Do not add invasive fingerprinting merely to improve attribution.

### Creator and community operations

Creator tools should include:

- unique attributable links/identifiers;
- activated-league and retained-league reporting;
- clear relationship/disclosure instructions;
- agreement fields for deliverables, compensation, honest opinion, factual claims, usage rights, cancellation, privacy, and no NHL affiliation;
- a creator-league mode or operational checklist;
- moderator-permission templates for Reddit, Discord, and Facebook communities.

Never require a positive review or conceal a material relationship.

### Capacity and cost

Before a broad public beta:

- run a staged 5,000-client test in a separate environment;
- model Draft-night and game-night traffic;
- measure reads, writes, Function duration, retries, queue age, and cost per active league/week;
- rehearse NHL/data-provider and dependent-service failures;
- define signup caps and emergency traffic controls;
- pause growth when support burden, reliability, cost, or retention turns red.

### Accessibility

Automated audits are not sufficient. Complete human WCAG 2.2 AA-oriented testing for keyboard, screen reader, zoom, contrast, timeout behavior, error recovery, reduced motion, and phone touch targets. Publish an accessibility contact path and retest major releases.

## Public product foundation

Before public commissioner acquisition, prepare:

- a focused landing page;
- public demo matchup with non-private data;
- 60–90 second explainer;
- current screenshots and social previews using cleared assets;
- rulebook and Help Center;
- scoring calculator;
- six-game fairness calculator/report;
- Next Six comparison tool;
- commissioner Draft checklist;
- waiver-decision worksheet;
- waitlist/demo request form;
- incident and accessibility contact paths.

## Controlled launch waves

Public beta should open in waves:

```text
5 activated leagues
10
25
50
100
```

Pause between waves and review integrity, action reliability, Draft completion, league filling, four-week retention, support, App Check/abuse evidence, cost, and legal status.

Do not scale paid acquisition because account creation or video views look strong. Scale only channels that produce activated and retained leagues.

## Native-app boundary

Continue with the PWA during the tester season and first public proof. Build native iOS/Android packaging only when measured retention shows that push delivery, store discovery, or a specific PWA limitation materially blocks growth.

## Season research and postmortem

At account/join, Draft, first matchup, first transaction, Week 4, midseason, and season end, capture the manager's mental model and founder dependence.

The final postmortem must quantify:

- integrity incidents;
- action reliability;
- scoring freshness;
- league activation and retention;
- commissioner independence;
- support burden;
- costs;
- features used weekly;
- information overload;
- next-season intent;
- reasons retained and churned commissioners give.

Only evidence-backed clarity and integrity fixes should change the live tester season. Production Scoring V4 and Projection V11 remain frozen midseason except for objective defects handled through a versioned correction process.
