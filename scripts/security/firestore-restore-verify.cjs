#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const functionsRequire = createRequire(path.join(projectRoot, 'functions/package.json'));
const { applicationDefault, deleteApp, initializeApp } = functionsRequire('firebase-admin/app');
const { getFirestore } = functionsRequire('firebase-admin/firestore');

function argumentValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
}

function firestoreFor(app, databaseId) {
  return databaseId === '(default)' ? getFirestore(app) : getFirestore(app, databaseId);
}

async function countCollection(query) {
  const snapshot = await query.count().get();
  return Number(snapshot.data().count ?? 0);
}

function uniqueNonEmpty(values) {
  const normalized = values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  return new Set(normalized).size === normalized.length;
}

async function sampleLeagueIntegrity(db, maximumSamples) {
  const snapshot = await db.collection('leagues').limit(maximumSamples).get();
  const totals = {
    sampledLeagues: snapshot.size,
    members: 0,
    teams: 0,
    rosters: 0,
    sixGameContracts: 0,
    scoringV3Contracts: 0,
    authorityV2Contracts: 0,
    completeIdentitySets: 0,
    duplicateMemberIdentifiers: 0,
    duplicateTeamOwners: 0,
  };

  for (const league of snapshot.docs) {
    const data = league.data() || {};
    if (Number(data.requiredGamesPerCycle) === 6) totals.sixGameContracts += 1;
    if (Number(data.scoringRulesVersion) === 3) totals.scoringV3Contracts += 1;
    if (Number(data.authoritySchemaVersion) >= 2) totals.authorityV2Contracts += 1;

    const [members, teams, rosters] = await Promise.all([
      league.ref.collection('members').get(),
      league.ref.collection('teams').get(),
      league.ref.collection('rosters').get(),
    ]);
    totals.members += members.size;
    totals.teams += teams.size;
    totals.rosters += rosters.size;

    const memberIds = members.docs.map((entry) => entry.data()?.uid ?? entry.id);
    const teamOwners = teams.docs.map((entry) => entry.data()?.ownerId ?? '');
    if (!uniqueNonEmpty(memberIds)) totals.duplicateMemberIdentifiers += 1;
    if (!uniqueNonEmpty(teamOwners)) totals.duplicateTeamOwners += 1;
    if (members.size === teams.size && teams.size === rosters.size && members.size > 0) {
      totals.completeIdentitySets += 1;
    }
  }

  return totals;
}

async function main() {
  const projectId = argumentValue('project') || 'nhl-fantasy-app-ab673';
  const sourceDatabase = argumentValue('source-database') || '(default)';
  const destinationDatabase = argumentValue('destination-database');
  const configPath = argumentValue('config') || path.join(projectRoot, 'config/firestore-backup-baseline.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const prefix = config?.restoreDrill?.databasePrefix || 'restore-drill';

  if (!destinationDatabase || destinationDatabase === '(default)' || !destinationDatabase.startsWith(`${prefix}-`)) {
    throw new Error(`Destination database must be a non-production ${prefix}-* restore drill.`);
  }

  const credential = applicationDefault();
  const sourceApp = initializeApp({ credential, projectId }, `rinkrat-backup-source-${Date.now()}`);
  const destinationApp = initializeApp({ credential, projectId }, `rinkrat-backup-destination-${Date.now()}`);

  try {
    const source = firestoreFor(sourceApp, sourceDatabase);
    const destination = firestoreFor(destinationApp, destinationDatabase);
    const topLevelCollections = config.restoreDrill.criticalTopLevelCollections || [];
    const collectionGroups = config.restoreDrill.criticalCollectionGroups || [];
    const appDataDocuments = config.restoreDrill.criticalAppDataDocuments || [];
    const maximumLeagueSamples = Number(config.restoreDrill.maximumLeagueSamples || 20);

    const topLevel = [];
    for (const collectionId of topLevelCollections) {
      const [sourceCount, destinationCount] = await Promise.all([
        countCollection(source.collection(collectionId)),
        countCollection(destination.collection(collectionId)),
      ]);
      topLevel.push({ collectionId, sourceCount, destinationCount });
    }

    const groups = [];
    for (const collectionId of collectionGroups) {
      const [sourceCount, destinationCount] = await Promise.all([
        countCollection(source.collectionGroup(collectionId)),
        countCollection(destination.collectionGroup(collectionId)),
      ]);
      groups.push({ collectionId, sourceCount, destinationCount });
    }

    const sentinels = [];
    for (const documentId of appDataDocuments) {
      const [sourceSnapshot, destinationSnapshot] = await Promise.all([
        source.doc(`appData/${documentId}`).get(),
        destination.doc(`appData/${documentId}`).get(),
      ]);
      sentinels.push({
        documentId,
        sourceExists: sourceSnapshot.exists,
        destinationExists: destinationSnapshot.exists,
      });
    }

    const [sourceLeagueIntegrity, destinationLeagueIntegrity] = await Promise.all([
      sampleLeagueIntegrity(source, maximumLeagueSamples),
      sampleLeagueIntegrity(destination, maximumLeagueSamples),
    ]);

    const hardFailures = [];
    const warnings = [];
    for (const item of topLevel) {
      if (item.sourceCount > 0 && item.destinationCount === 0) {
        hardFailures.push(`${item.collectionId} is populated in production but empty in the restore drill.`);
      } else if (item.sourceCount !== item.destinationCount) {
        warnings.push(`${item.collectionId} count differs (${item.sourceCount} source, ${item.destinationCount} restored); production may have changed after the backup snapshot.`);
      }
    }
    for (const item of groups) {
      if (item.sourceCount > 0 && item.destinationCount === 0) {
        hardFailures.push(`${item.collectionId} collection-group data is missing from the restore drill.`);
      } else if (item.sourceCount !== item.destinationCount) {
        warnings.push(`${item.collectionId} count differs (${item.sourceCount} source, ${item.destinationCount} restored).`);
      }
    }
    for (const item of sentinels) {
      if (item.sourceExists && !item.destinationExists) {
        warnings.push(`appData/${item.documentId} exists now but was not present in the restored backup.`);
      }
    }
    if (destinationLeagueIntegrity.duplicateMemberIdentifiers > 0) {
      hardFailures.push(`${destinationLeagueIntegrity.duplicateMemberIdentifiers} sampled restored league(s) contain duplicate member identifiers.`);
    }
    if (destinationLeagueIntegrity.duplicateTeamOwners > 0) {
      hardFailures.push(`${destinationLeagueIntegrity.duplicateTeamOwners} sampled restored league(s) contain duplicate team owners.`);
    }
    if (destinationLeagueIntegrity.sampledLeagues > 0 && destinationLeagueIntegrity.sixGameContracts === 0) {
      hardFailures.push('No sampled restored league preserved the six-game contract.');
    }
    if (destinationLeagueIntegrity.sampledLeagues > 0 && destinationLeagueIntegrity.scoringV3Contracts === 0) {
      hardFailures.push('No sampled restored league preserved Scoring V3.');
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      projectId,
      sourceDatabase,
      destinationDatabase,
      result: hardFailures.length === 0 ? 'PASS' : 'FAIL',
      topLevel,
      collectionGroups: groups,
      appDataSentinels: sentinels,
      sourceLeagueIntegrity,
      destinationLeagueIntegrity,
      hardFailures,
      warnings,
    };
    report.reportHash = createHash('sha256').update(JSON.stringify(report)).digest('hex');

    const reportDirectory = path.join(projectRoot, '.security-reports/firestore-recovery');
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = path.join(reportDirectory, `${destinationDatabase}-verification.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(`Firestore restore drill ${report.result}: ${destinationDatabase}`);
    console.log(`- Top-level collections checked: ${topLevel.length}`);
    console.log(`- Collection groups checked: ${groups.length}`);
    console.log(`- Sampled restored leagues: ${destinationLeagueIntegrity.sampledLeagues}`);
    console.log(`- Six-game contracts preserved: ${destinationLeagueIntegrity.sixGameContracts}`);
    console.log(`- Scoring V3 contracts preserved: ${destinationLeagueIntegrity.scoringV3Contracts}`);
    console.log(`- Privacy-limited report: ${path.relative(projectRoot, reportPath)}`);
    warnings.forEach((warning) => console.log(`- Advisory: ${warning}`));
    hardFailures.forEach((failure) => console.error(`- Failure: ${failure}`));

    if (hardFailures.length > 0) process.exitCode = 1;
  } finally {
    await Promise.allSettled([deleteApp(sourceApp), deleteApp(destinationApp)]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
