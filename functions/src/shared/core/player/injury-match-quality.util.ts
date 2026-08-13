export type InjuryMatchSkaterPosition = 'LW' | 'C' | 'RW' | 'D';

export type InjuryMatchIssueCategory =
  | 'name-not-found'
  | 'ambiguous-name'
  | 'alias-target-missing'
  | 'team-discrepancy'
  | 'position-discrepancy';

export type InjuryMatchIssueResolution =
  | 'unresolved'
  | 'matched-with-advisory';

export interface InjuryMatchPlayer {
  id: number;
  fullName: string;
  position: InjuryMatchSkaterPosition;
  nhlTeamAbbreviation: string;
}

export interface InjuryMatchSourceEntry {
  playerName: string;
  position: string;
  teamName: string;
  rawStatus: string;
  fantasyStatus: string;
  injuryType: string;
  normalizedStatus: string;
}

export interface InjuryPlayerAlias {
  sourceName: string;
  playerId: number;
  sourceTeamAbbreviation?: string;
  note?: string;
}

export interface InjuryMatchCandidateSuggestion {
  playerName: string;
  teamAbbreviation: string;
  position: InjuryMatchSkaterPosition;
  reason: string;
}

export interface InjuryMatchIssue {
  sourcePlayerName: string;
  sourceTeamName: string;
  sourceTeamAbbreviation: string;
  sourcePosition: string;
  sourceStatus: string;
  category: InjuryMatchIssueCategory;
  resolution: InjuryMatchIssueResolution;
  candidateSuggestions: InjuryMatchCandidateSuggestion[];
}

export interface InjuryMatchQualityCounts {
  nameNotFound: number;
  ambiguousName: number;
  aliasTargetMissing: number;
  teamDiscrepancy: number;
  positionDiscrepancy: number;
}

export interface InjuryMatchQuality {
  schemaVersion: 1;
  generatedAt: string;
  sourceEntryCount: number;
  matchedSkaterCount: number;
  unresolvedSkaterCount: number;
  matchedWithAdvisoryCount: number;
  aliasResolvedCount: number;
  skippedGoalieCount: number;
  counts: InjuryMatchQualityCounts;
  issues: InjuryMatchIssue[];
}

export interface InjuryMatchResult<
  TPlayer extends InjuryMatchPlayer,
  TEntry extends InjuryMatchSourceEntry,
> {
  matches: Array<{
    player: TPlayer;
    injury: TEntry;
  }>;
  unmatchedNames: string[];
  skippedGoalieCount: number;
  matchQuality: InjuryMatchQuality;
}

export interface InjuryMatchOptions<TEntry extends InjuryMatchSourceEntry> {
  generatedAt: string;
  resolveTeamAbbreviation: (teamName: string) => string;
  chooseStrongerEntry: (first: TEntry, second: TEntry) => TEntry;
  aliases?: readonly InjuryPlayerAlias[];
}

const MAX_ISSUES = 60;
const MAX_CANDIDATE_SUGGESTIONS = 3;
const MAX_PUBLIC_TEXT_LENGTH = 120;
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

function boundedText(value: string): string {
  return value.trim().slice(0, MAX_PUBLIC_TEXT_LENGTH);
}

export function normalizeInjuryIdentityText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizedPosition(value: string): InjuryMatchSkaterPosition | null {
  switch (value.trim().toUpperCase()) {
    case 'L':
    case 'LW':
      return 'LW';

    case 'C':
      return 'C';

    case 'R':
    case 'RW':
      return 'RW';

    case 'D':
      return 'D';

    default:
      return null;
  }
}

function normalizedNameTokens(value: string): string[] {
  const tokens = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  return tokens;
}

function aliasKey(sourceName: string, teamAbbreviation = ''): string {
  return `${normalizeInjuryIdentityText(sourceName)}:${teamAbbreviation.trim().toUpperCase()}`;
}

function buildAliasMap(
  aliases: readonly InjuryPlayerAlias[],
): Map<string, InjuryPlayerAlias> {
  const map = new Map<string, InjuryPlayerAlias>();

  for (const alias of aliases) {
    const normalizedName = normalizeInjuryIdentityText(alias.sourceName);

    if (
      !normalizedName ||
      !Number.isSafeInteger(alias.playerId) ||
      alias.playerId <= 0
    ) {
      continue;
    }

    const team = alias.sourceTeamAbbreviation?.trim().toUpperCase() ?? '';
    map.set(aliasKey(alias.sourceName, team), alias);
  }

  return map;
}

function candidateSuggestionReason(input: {
  sameSurname: boolean;
  sameTeam: boolean;
  samePosition: boolean;
  sameFirstInitial: boolean;
}): string {
  const reasons: string[] = [];

  if (input.sameSurname) {
    reasons.push('same surname');
  }

  if (input.sameTeam) {
    reasons.push('same team');
  }

  if (input.samePosition) {
    reasons.push('same position');
  }

  if (input.sameFirstInitial) {
    reasons.push('same first initial');
  }

  return reasons.slice(0, 3).join(', ') || 'similar roster context';
}

function buildCandidateSuggestions<TPlayer extends InjuryMatchPlayer>(
  entry: InjuryMatchSourceEntry,
  players: readonly TPlayer[],
  resolveTeamAbbreviation: (teamName: string) => string,
): InjuryMatchCandidateSuggestion[] {
  const sourceTokens = normalizedNameTokens(entry.playerName);
  const sourceFirstInitial = sourceTokens[0]?.[0] ?? '';
  const sourceSurname = sourceTokens[sourceTokens.length - 1] ?? '';
  const sourceTeam = resolveTeamAbbreviation(entry.teamName).toUpperCase();
  const sourcePosition = normalizedPosition(entry.position);

  return players
    .map((player) => {
      const candidateTokens = normalizedNameTokens(player.fullName);
      const candidateFirstInitial = candidateTokens[0]?.[0] ?? '';
      const candidateSurname = candidateTokens[candidateTokens.length - 1] ?? '';
      const sameSurname = Boolean(sourceSurname && sourceSurname === candidateSurname);
      const sameTeam = Boolean(
        sourceTeam && sourceTeam === player.nhlTeamAbbreviation.toUpperCase(),
      );
      const samePosition = Boolean(sourcePosition && sourcePosition === player.position);
      const sameFirstInitial = Boolean(
        sourceFirstInitial && sourceFirstInitial === candidateFirstInitial,
      );
      const score =
        (sameSurname ? 6 : 0) +
        (sameTeam ? 4 : 0) +
        (samePosition ? 2 : 0) +
        (sameFirstInitial ? 1 : 0);

      return {
        score,
        playerName: boundedText(player.fullName),
        teamAbbreviation: boundedText(player.nhlTeamAbbreviation.toUpperCase()),
        position: player.position,
        reason: candidateSuggestionReason({
          sameSurname,
          sameTeam,
          samePosition,
          sameFirstInitial,
        }),
      };
    })
    .filter((candidate) => candidate.score >= 6)
    .sort((left, right) =>
      right.score - left.score ||
      left.playerName.localeCompare(right.playerName),
    )
    .slice(0, MAX_CANDIDATE_SUGGESTIONS)
    .map(({ score: _score, ...candidate }) => candidate);
}

function sourceStatus(entry: InjuryMatchSourceEntry): string {
  return boundedText(
    entry.rawStatus ||
      entry.fantasyStatus ||
      entry.injuryType ||
      entry.normalizedStatus ||
      'Unknown',
  );
}

function issueFingerprint(issue: InjuryMatchIssue): string {
  return [
    issue.category,
    normalizeInjuryIdentityText(issue.sourcePlayerName),
    issue.sourceTeamAbbreviation,
    issue.sourcePosition,
  ].join(':');
}

function incrementIssueCount(
  counts: InjuryMatchQualityCounts,
  category: InjuryMatchIssueCategory,
): void {
  switch (category) {
    case 'name-not-found':
      counts.nameNotFound += 1;
      break;

    case 'ambiguous-name':
      counts.ambiguousName += 1;
      break;

    case 'alias-target-missing':
      counts.aliasTargetMissing += 1;
      break;

    case 'team-discrepancy':
      counts.teamDiscrepancy += 1;
      break;

    case 'position-discrepancy':
      counts.positionDiscrepancy += 1;
      break;
  }
}

function createIssue<TPlayer extends InjuryMatchPlayer>(input: {
  entry: InjuryMatchSourceEntry;
  category: InjuryMatchIssueCategory;
  resolution: InjuryMatchIssueResolution;
  players: readonly TPlayer[];
  resolveTeamAbbreviation: (teamName: string) => string;
  candidatePool?: readonly TPlayer[];
}): InjuryMatchIssue {
  const teamAbbreviation = input.resolveTeamAbbreviation(input.entry.teamName);
  const candidatePool = input.candidatePool ?? input.players;

  return {
    sourcePlayerName: boundedText(input.entry.playerName),
    sourceTeamName: boundedText(input.entry.teamName),
    sourceTeamAbbreviation: boundedText(teamAbbreviation.toUpperCase()),
    sourcePosition: boundedText(input.entry.position.toUpperCase()),
    sourceStatus: sourceStatus(input.entry),
    category: input.category,
    resolution: input.resolution,
    candidateSuggestions: buildCandidateSuggestions(
      input.entry,
      candidatePool,
      input.resolveTeamAbbreviation,
    ),
  };
}

export function matchInjuryEntriesToCurrentPlayers<
  TPlayer extends InjuryMatchPlayer,
  TEntry extends InjuryMatchSourceEntry,
>(
  entries: readonly TEntry[],
  players: readonly TPlayer[],
  options: InjuryMatchOptions<TEntry>,
): InjuryMatchResult<TPlayer, TEntry> {
  const playersByName = new Map<string, TPlayer[]>();
  const playersById = new Map<number, TPlayer>();

  for (const player of players) {
    const key = normalizeInjuryIdentityText(player.fullName);
    const candidates = playersByName.get(key) ?? [];
    candidates.push(player);
    playersByName.set(key, candidates);
    playersById.set(player.id, player);
  }

  const aliasMap = buildAliasMap(options.aliases ?? []);
  const matchedByPlayerId = new Map<
    number,
    { player: TPlayer; injury: TEntry }
  >();
  const unresolvedNames = new Set<string>();
  const issues: InjuryMatchIssue[] = [];
  const issueFingerprints = new Set<string>();
  const counts: InjuryMatchQualityCounts = {
    nameNotFound: 0,
    ambiguousName: 0,
    aliasTargetMissing: 0,
    teamDiscrepancy: 0,
    positionDiscrepancy: 0,
  };
  let skippedGoalieCount = 0;
  let aliasResolvedCount = 0;

  const addIssue = (issue: InjuryMatchIssue): void => {
    const fingerprint = issueFingerprint(issue);

    if (issueFingerprints.has(fingerprint)) {
      return;
    }

    issueFingerprints.add(fingerprint);
    incrementIssueCount(counts, issue.category);

    if (issues.length < MAX_ISSUES) {
      issues.push(issue);
    }
  };

  for (const entry of entries) {
    if (entry.position.trim().toUpperCase() === 'G') {
      skippedGoalieCount += 1;
      continue;
    }

    const sourceTeam = options.resolveTeamAbbreviation(entry.teamName).toUpperCase();
    const exactTeamAlias = aliasMap.get(aliasKey(entry.playerName, sourceTeam));
    const genericAlias = aliasMap.get(aliasKey(entry.playerName));
    const alias = exactTeamAlias ?? genericAlias;
    let player: TPlayer | null = null;

    if (alias) {
      player = playersById.get(alias.playerId) ?? null;

      if (!player) {
        unresolvedNames.add(entry.playerName);
        addIssue(
          createIssue({
            entry,
            category: 'alias-target-missing',
            resolution: 'unresolved',
            players,
            resolveTeamAbbreviation: options.resolveTeamAbbreviation,
          }),
        );
        continue;
      }

      aliasResolvedCount += 1;
    } else {
      const exactNameCandidates = playersByName.get(
        normalizeInjuryIdentityText(entry.playerName),
      ) ?? [];

      if (exactNameCandidates.length === 0) {
        unresolvedNames.add(entry.playerName);
        addIssue(
          createIssue({
            entry,
            category: 'name-not-found',
            resolution: 'unresolved',
            players,
            resolveTeamAbbreviation: options.resolveTeamAbbreviation,
          }),
        );
        continue;
      }

      let candidates = [...exactNameCandidates];
      const sourcePosition = normalizedPosition(entry.position);

      if (candidates.length > 1 && sourceTeam) {
        const matchingTeam = candidates.filter(
          (candidate) =>
            candidate.nhlTeamAbbreviation.toUpperCase() === sourceTeam,
        );

        if (matchingTeam.length === 1) {
          candidates = matchingTeam;
        } else if (matchingTeam.length > 1 && sourcePosition) {
          const matchingTeamAndPosition = matchingTeam.filter(
            (candidate) => candidate.position === sourcePosition,
          );

          candidates = matchingTeamAndPosition.length > 0
            ? matchingTeamAndPosition
            : matchingTeam;
        }
      } else if (candidates.length > 1 && sourcePosition) {
        const matchingPosition = candidates.filter(
          (candidate) => candidate.position === sourcePosition,
        );

        if (matchingPosition.length > 0) {
          candidates = matchingPosition;
        }
      }

      if (candidates.length !== 1) {
        unresolvedNames.add(entry.playerName);
        addIssue(
          createIssue({
            entry,
            category: 'ambiguous-name',
            resolution: 'unresolved',
            players,
            candidatePool: candidates,
            resolveTeamAbbreviation: options.resolveTeamAbbreviation,
          }),
        );
        continue;
      }

      player = candidates[0];
    }

    const sourcePosition = normalizedPosition(entry.position);

    if (
      sourcePosition &&
      player.position !== sourcePosition
    ) {
      addIssue(
        createIssue({
          entry,
          category: 'position-discrepancy',
          resolution: 'matched-with-advisory',
          players,
          candidatePool: [player],
          resolveTeamAbbreviation: options.resolveTeamAbbreviation,
        }),
      );
    }

    if (
      sourceTeam &&
      player.nhlTeamAbbreviation.toUpperCase() !== sourceTeam
    ) {
      addIssue(
        createIssue({
          entry,
          category: 'team-discrepancy',
          resolution: 'matched-with-advisory',
          players,
          candidatePool: [player],
          resolveTeamAbbreviation: options.resolveTeamAbbreviation,
        }),
      );
    }

    const existing = matchedByPlayerId.get(player.id);
    matchedByPlayerId.set(player.id, {
      player,
      injury: existing
        ? options.chooseStrongerEntry(existing.injury, entry)
        : entry,
    });
  }

  issues.sort((left, right) => {
    if (left.resolution !== right.resolution) {
      return left.resolution === 'unresolved' ? -1 : 1;
    }

    return left.sourcePlayerName.localeCompare(right.sourcePlayerName);
  });

  const unresolvedSkaterCount = unresolvedNames.size;
  const matchedWithAdvisoryCount = issues.filter(
    (issue) => issue.resolution === 'matched-with-advisory',
  ).length;

  return {
    matches: [...matchedByPlayerId.values()],
    unmatchedNames: [...unresolvedNames].sort((left, right) =>
      left.localeCompare(right),
    ),
    skippedGoalieCount,
    matchQuality: {
      schemaVersion: 1,
      generatedAt: options.generatedAt,
      sourceEntryCount: entries.length,
      matchedSkaterCount: matchedByPlayerId.size,
      unresolvedSkaterCount,
      matchedWithAdvisoryCount,
      aliasResolvedCount,
      skippedGoalieCount,
      counts,
      issues,
    },
  };
}
