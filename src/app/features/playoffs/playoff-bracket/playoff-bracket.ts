import { Component, computed, OnDestroy, signal } from '@angular/core';

import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import { areDeveloperToolsEnabled } from '../../../core/cycle/cycle-runtime.config';

import { getLeagueById, League } from '../../../core/league/league.service';

import {
  buildFantasyStandings,
  FantasyStandingSnapshot,
} from '../../../core/league/standings.util';

import {
  getPlacementGameLabel,
  getPlayoffRoundLabel,
  getStandardPlayoffRoundCount,
  getStandardPlayoffTeamCount,
  getStandardRegularSeasonCycleCount,
} from '../../../core/playoffs/playoff-format';

import {
  FantasyPlayoffMatchup,
  FantasyPlayoffPlacement,
  FantasyPlayoffs,
} from '../../../core/playoffs/playoff.models';

import { listenToFantasyPlayoffs } from '../../../core/playoffs/playoff.service';

import { FantasyTeam, getLeagueTeams } from '../../../core/team/team.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-playoff-bracket',
  imports: [RouterLink],
  templateUrl: './playoff-bracket.html',
  styleUrl: './playoff-bracket.css',
})
export class PlayoffBracket implements OnDestroy {
  readonly developerToolsEnabled = areDeveloperToolsEnabled();
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  playoffs = signal<FantasyPlayoffs | null>(null);
  loading = signal(true);
  errorMessage = signal('');

  private stopPlayoffsListener: (() => void) | null = null;

  readonly previewStandings = computed<FantasyStandingSnapshot[]>(() =>
    buildFantasyStandings(this.teams()),
  );

  readonly playoffTeamCount = computed(
    () => this.playoffs()?.playoffTeamCount ?? getStandardPlayoffTeamCount(this.teams().length),
  );

  readonly playoffRoundCount = computed(
    () =>
      this.playoffs()?.playoffRoundCount ?? getStandardPlayoffRoundCount(this.playoffTeamCount()),
  );

  readonly regularSeasonCycleCount = computed(
    () =>
      this.playoffs()?.regularSeasonCycleCount ??
      getStandardRegularSeasonCycleCount(this.teams().length),
  );

  readonly roundNumbers = computed(() =>
    Array.from({ length: this.playoffRoundCount() }, (_, index) => index + 1),
  );

  readonly championshipSeeds = computed(() => {
    const savedSeeds = this.playoffs()?.seeds;

    if (savedSeeds?.length) {
      return savedSeeds.slice(0, this.playoffTeamCount());
    }

    return this.previewStandings()
      .slice(0, this.playoffTeamCount())
      .map((standing, index) => ({
        seed: index + 1,
        ...standing,
      }));
  });

  readonly consolationSeeds = computed(() => {
    const savedSeeds = this.playoffs()?.seeds;

    if (savedSeeds?.length) {
      return savedSeeds.slice(this.playoffTeamCount());
    }

    return this.previewStandings()
      .slice(this.playoffTeamCount())
      .map((standing, index) => ({
        seed: this.playoffTeamCount() + index + 1,
        ...standing,
      }));
  });

  readonly placements = computed<FantasyPlayoffPlacement[]>(() =>
    [...(this.playoffs()?.placements ?? [])].sort((first, second) => first.place - second.place),
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    void this.loadPage();
  }

  ngOnDestroy(): void {
    this.stopPlayoffsListener?.();
  }

  isCommissioner(): boolean {
    return this.league()?.commissionerId === this.userId;
  }

  getTeamWindowLabel(matchup: FantasyPlayoffMatchup, side: 'A' | 'B'): string {
    const windowNumber = side === 'A' ? matchup.teamAWindowNumber : matchup.teamBWindowNumber;
    const cycleNumber =
      side === 'A' ? matchup.teamAWindowCycleNumber : matchup.teamBWindowCycleNumber;

    if (!windowNumber || !cycleNumber) {
      return 'Window pending';
    }

    return `Window ${windowNumber} · block ${cycleNumber}`;
  }

  isPlayoffsStarted(): boolean {
    return this.playoffs() !== null;
  }

  isPlayoffsComplete(): boolean {
    return this.playoffs()?.status === 'complete';
  }

  getRoundLabel(roundNumber: number): string {
    return getPlayoffRoundLabel(roundNumber, this.playoffRoundCount());
  }

  getRoundCycleNumber(roundNumber: number): number {
    return this.regularSeasonCycleCount() + roundNumber;
  }

  getRoundMatchups(
    roundNumber: number,
    bracketType: 'championship' | 'consolation',
  ): FantasyPlayoffMatchup[] {
    return (this.playoffs()?.matchups ?? [])
      .filter(
        (matchup) => matchup.roundNumber === roundNumber && matchup.bracketType === bracketType,
      )
      .sort((first, second) => first.id.localeCompare(second.id));
  }

  getDisplayRoundMatchups(roundNumber: number): FantasyPlayoffMatchup[] {
    const matchups = (this.playoffs()?.matchups ?? [])
      .filter((matchup) => matchup.roundNumber === roundNumber)
      .sort((first, second) => {
        const bracketPriority = this.getBracketPriority(first) - this.getBracketPriority(second);

        if (bracketPriority !== 0) {
          return bracketPriority;
        }

        const placePriority = this.getPlacementPriority(first) - this.getPlacementPriority(second);

        if (placePriority !== 0) {
          return placePriority;
        }

        return first.id.localeCompare(second.id);
      });

    return matchups;
  }

  hasConsolationBracket(): boolean {
    return this.consolationSeeds().length > 0;
  }

  getMatchupLabel(matchup: FantasyPlayoffMatchup): string {
    const placementLabel = getPlacementGameLabel(matchup);

    if (placementLabel !== 'Championship Bracket' && placementLabel !== 'Consolation Bracket') {
      return placementLabel;
    }

    if (matchup.bracketType === 'consolation') {
      return 'Consolation Matchup';
    }

    return this.getRoundLabel(matchup.roundNumber);
  }

  getTeamName(ownerId: string | null): string {
    if (!ownerId) {
      return 'To Be Determined';
    }

    return (
      this.playoffs()?.seeds.find((seed) => seed.ownerId === ownerId)?.teamName ??
      this.teams().find((team) => team.ownerId === ownerId)?.teamName ??
      'Unknown Team'
    );
  }

  getSeed(ownerId: string | null): number | null {
    if (!ownerId) {
      return null;
    }

    return this.playoffs()?.seeds.find((seed) => seed.ownerId === ownerId)?.seed ?? null;
  }

  getRecordLabel(standing: Pick<FantasyStandingSnapshot, 'wins' | 'losses' | 'ties'>): string {
    return `${standing.wins}-${standing.losses}-${standing.ties}`;
  }

  getScoreLabel(value: number | null): string {
    return value === null ? '—' : value.toFixed(1);
  }

  getMatchupStatusLabel(matchup: FantasyPlayoffMatchup): string {
    if (matchup.status === 'complete') {
      return matchup.tieBrokenByHigherSeed ? 'Final · Higher seed advanced on tie' : 'Final';
    }

    if (matchup.status === 'active') {
      return 'Active';
    }

    return 'Awaiting previous result';
  }

  isWinner(matchup: FantasyPlayoffMatchup, ownerId: string | null): boolean {
    return Boolean(ownerId && matchup.winnerOwnerId === ownerId);
  }

  getMatchupLink(matchup: FantasyPlayoffMatchup): unknown[] | null {
    if (matchup.status === 'scheduled' || !matchup.teamAOwnerId || !matchup.teamBOwnerId) {
      return null;
    }

    return ['/leagues', this.leagueId, 'cycles', matchup.cycleNumber, 'matchups', matchup.id];
  }

  getChampionName(): string {
    return this.getTeamName(this.playoffs()?.championOwnerId ?? null);
  }

  getFormatSummary(): string {
    const playoffTeams = this.playoffTeamCount();
    const rounds = this.playoffRoundCount();
    const byeCount = Math.max(0, playoffTeams - 4);

    if (byeCount > 0) {
      return `${playoffTeams} championship qualifiers, ${rounds} rounds, and first-round byes for the top ${byeCount} seeds.`;
    }

    return `${playoffTeams} championship qualifiers across ${rounds} ${rounds === 1 ? 'round' : 'rounds'}.`;
  }

  getSeedGroupTitle(isChampionshipSeed: boolean): string {
    return isChampionshipSeed ? 'Championship Qualifiers' : 'Placement Field';
  }

  getSeedBadgeLabel(seedNumber: number): string {
    return seedNumber <= this.playoffTeamCount() ? 'Championship Seed' : 'Placement Seed';
  }

  getSeedProgressLabel(ownerId: string, seedNumber: number): string {
    const placement = this.placements().find((entry) => entry.ownerId === ownerId);

    if (placement) {
      return `Finished ${this.getOrdinalPlaceLabel(placement.place)}`;
    }

    const latestMatchup = this.getLatestMatchupForOwner(ownerId);

    if (!latestMatchup) {
      return seedNumber <= this.playoffTeamCount()
        ? 'Entered the championship bracket.'
        : 'Entered the placement bracket.';
    }

    if (latestMatchup.status === 'scheduled') {
      return `Up next: ${this.getMatchupLabel(latestMatchup)}`;
    }

    if (
      latestMatchup.status === 'active' &&
      (latestMatchup.teamAOwnerId === ownerId || latestMatchup.teamBOwnerId === ownerId)
    ) {
      return `Currently playing in the ${this.getMatchupLabel(latestMatchup)}.`;
    }

    if (latestMatchup.winnerOwnerId === ownerId) {
      const nextMatchup = this.findDestinationMatchup(latestMatchup.id, 'winner');

      if (nextMatchup) {
        return `Advanced to the ${this.getMatchupLabel(nextMatchup)}.`;
      }

      return latestMatchup.winnerPlace === null
        ? 'Advanced in the bracket.'
        : `Finished ${this.getOrdinalPlaceLabel(latestMatchup.winnerPlace)}`;
    }

    if (latestMatchup.loserOwnerId === ownerId) {
      const nextMatchup = this.findDestinationMatchup(latestMatchup.id, 'loser');

      if (nextMatchup) {
        return `Dropped to the ${this.getMatchupLabel(nextMatchup)}.`;
      }

      return latestMatchup.loserPlace === null
        ? 'Moved into placement play.'
        : `Finished ${this.getOrdinalPlaceLabel(latestMatchup.loserPlace)}`;
    }

    return `Placed into the ${this.getMatchupLabel(latestMatchup)}.`;
  }

  getMatchupPathLabel(matchup: FantasyPlayoffMatchup): string {
    if (matchup.winnerPlace === 1) {
      return 'Title path';
    }

    if (matchup.bracketType === 'championship' && matchup.winnerPlace === 3) {
      return 'Third-place path';
    }

    if (matchup.bracketType === 'consolation') {
      return 'Placement path';
    }

    return 'Championship path';
  }

  getAdvanceLabel(matchup: FantasyPlayoffMatchup, resultType: 'winner' | 'loser'): string {
    const nextMatchup = this.findDestinationMatchup(matchup.id, resultType);

    if (nextMatchup) {
      return this.getMatchupLabel(nextMatchup);
    }

    const finalPlace = resultType === 'winner' ? matchup.winnerPlace : matchup.loserPlace;

    return finalPlace === null ? 'Eliminated' : `Finish ${this.getOrdinalPlaceLabel(finalPlace)}`;
  }

  getOrdinalPlaceLabel(place: number): string {
    return `${place}${this.getOrdinalSuffix(place)} place`;
  }

  private findDestinationMatchup(
    matchupId: string,
    resultType: 'winner' | 'loser',
  ): FantasyPlayoffMatchup | null {
    return (
      (this.playoffs()?.matchups ?? []).find(
        (candidate) =>
          (candidate.sourceA.type === resultType && candidate.sourceA.matchupId === matchupId) ||
          (candidate.sourceB.type === resultType && candidate.sourceB.matchupId === matchupId),
      ) ?? null
    );
  }

  private getLatestMatchupForOwner(ownerId: string): FantasyPlayoffMatchup | null {
    const matchups = (this.playoffs()?.matchups ?? [])
      .filter(
        (matchup) =>
          matchup.teamAOwnerId === ownerId ||
          matchup.teamBOwnerId === ownerId ||
          matchup.winnerOwnerId === ownerId ||
          matchup.loserOwnerId === ownerId,
      )
      .sort((first, second) => {
        if (first.roundNumber !== second.roundNumber) {
          return second.roundNumber - first.roundNumber;
        }

        if (first.status !== second.status) {
          const statusRank = {
            active: 3,
            scheduled: 2,
            complete: 1,
          } as const;

          return statusRank[second.status] - statusRank[first.status];
        }

        return second.id.localeCompare(first.id);
      });

    return matchups[0] ?? null;
  }

  private getBracketPriority(matchup: FantasyPlayoffMatchup): number {
    if (matchup.bracketType === 'championship') {
      return matchup.winnerPlace === 3 ? 2 : 1;
    }

    return 3;
  }

  private getPlacementPriority(matchup: FantasyPlayoffMatchup): number {
    if (matchup.winnerPlace === 1) {
      return 0;
    }

    if (matchup.winnerPlace === 3) {
      return 1;
    }

    return matchup.winnerPlace ?? 99;
  }

  private getOrdinalSuffix(value: number): string {
    const lastTwoDigits = value % 100;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
      return 'th';
    }

    switch (value % 10) {
      case 1:
        return 'st';
      case 2:
        return 'nd';
      case 3:
        return 'rd';
      default:
        return 'th';
    }
  }

  private async loadPage(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.userId = user.uid;

    try {
      const [league, teams] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
      ]);

      if (!league) {
        throw new Error('League not found.');
      }

      this.league.set(league);
      this.teams.set(teams);

      this.stopPlayoffsListener = listenToFantasyPlayoffs(
        leagueId,
        (playoffs) => {
          this.playoffs.set(playoffs);
          this.loading.set(false);
        },
        (error) => {
          this.errorMessage.set(error.message);
          this.loading.set(false);
        },
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load the playoff bracket.',
      );
      this.loading.set(false);
    }
  }
}
