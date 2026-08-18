import { Component, computed, OnDestroy, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, Subscription } from 'rxjs';

import { TelemetryService } from '../../core/observability/telemetry.service';
import { DialogFocusTrapDirective } from '../accessibility/dialog-focus-trap.directive';
import { HockeyTermChip } from '../hockey-terms/hockey-term-chip';
import { HOCKEY_GLOSSARY_TERMS } from '../hockey-terms/hockey-terms.data';

interface CoachGuide {
  id: string;
  title: string;
  subtitle: string;
  tips: string[];
}

const DEFAULT_GUIDE: CoachGuide = {
  id: 'general',
  title: 'RinkRat Coach',
  subtitle: 'Quick help for the screen you are using.',
  tips: [
    'Use Training Camp for the full five-shift introduction to RinkRat.',
    'Green, yellow, and red markers mean played, upcoming, and missed games.',
    'When a status is unclear, open the nearest details or comparison panel before acting.',
  ],
};

@Component({
  selector: 'app-coach-help',
  standalone: true,
  imports: [RouterLink, DialogFocusTrapDirective, HockeyTermChip],
  templateUrl: './coach-help.html',
  styleUrl: './coach-help.css',
})
export class CoachHelp implements OnDestroy {
  readonly open = signal(false);
  readonly currentUrl = signal('');
  readonly glossaryTerms = HOCKEY_GLOSSARY_TERMS;

  readonly guide = computed<CoachGuide>(() => this.buildGuide(this.currentUrl()));

  private readonly routeSubscription: Subscription;

  constructor(
    private readonly router: Router,
    private readonly telemetry: TelemetryService,
  ) {
    this.currentUrl.set(this.router.url);
    this.routeSubscription = this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.currentUrl.set(event.urlAfterRedirects);
        this.open.set(false);
      });
  }

  ngOnDestroy(): void {
    this.routeSubscription.unsubscribe();
  }

  toggle(): void {
    const nextOpen = !this.open();
    this.open.set(nextOpen);

    if (nextOpen) {
      this.telemetry.track('coach_help_opened', {
        topic: this.guide().id,
      });

    }
  }

  close(): void {
    if (!this.open()) {
      return;
    }

    this.open.set(false);
  }

  private buildGuide(rawUrl: string): CoachGuide {
    const url = rawUrl.split(/[?#]/)[0];

    if (url === '/scoring' || url.endsWith('/scoring')) {
      return {
        id: 'scoring_guide',
        title: 'Scoring Guide',
        subtitle: 'Use the exact tables and examples to understand every point.',
        tips: [
          'Goals and assists use diminishing returns inside each NHL game, then reset in the next game.',
          'Power-play, short-handed, game-winning, and overtime bonuses stack with the normal scoring play.',
          'Use the league version of this page when you need the exact rules frozen to an existing league.',
        ],
      };
    }

    if (url === '/training-camp') {
      return {
        id: 'training_camp',
        title: 'Training Camp',
        subtitle: 'Move through all five shifts at your own pace.',
        tips: [
          'Use the numbered tabs to revisit any lesson.',
          'Finishing saves completion to your RinkRat account.',
          'You can replay Training Camp later without losing progress.',
        ],
      };
    }

    if (url.includes('/draft/setup')) {
      return {
        id: 'draft_setup',
        title: 'Commissioner Draft Setup',
        subtitle: 'Prepare a fair draft before opening the room.',
        tips: [
          'Confirm every expected manager has joined before finalizing draft order.',
          'RinkRat needs a healthy shared projection snapshot before a draft can start.',
          'Scheduled drafts open automatically; the commissioner does not need to press Start at the deadline.',
        ],
      };
    }

    if (/\/draft(?:$|\/)/.test(url)) {
      return {
        id: 'draft_room',
        title: 'Draft Room',
        subtitle: 'Build every starter before filling the bench.',
        tips: [
          'Queue players in the order you want RinkRat to consider them.',
          'Auto-Draft acts when your team is on the clock and follows roster-position rules.',
          'The player pool, draft order, timer, and roster board update live for every manager.',
        ],
      };
    }

    if (url.includes('/free-agents')) {
      return {
        id: 'add_drop',
        title: 'Scouting & Add/Drop',
        subtitle: 'Compare production, projection, availability, and timing before making a move.',
        tips: [
          'Open the season breakdown to see exactly how current fantasy points were earned.',
          'Green, yellow, and red dots show played, upcoming, and missed games in the current six-game count.',
          'The confirmation screen tells you whether the transaction happens now or after the affected roster spot finishes its six games.',
        ],
      };
    }

    if (url.includes('/team')) {
      return {
        id: 'my_team',
        title: 'Locker Room',
        subtitle: 'Manage active slots, bench depth, Injured Reserve, and scheduled changes.',
        tips: [
          'A slot can change immediately when neither involved player or goalie unit has played in its current six-game count.',
          'Only eligible unavailable players can move into Injured Reserve (IR).',
          'Bench and scheduled-move indicators show what will change after the affected roster spot finishes its six games.',
        ],
      };
    }

    if (url.includes('/matchups') || /\/cycles\/\d+$/.test(url)) {
      return {
        id: 'matchup',
        title: 'Live Matchup',
        subtitle: 'Each roster slot is following its own six-game NHL count.',
        tips: [
          'Current is the score already earned; Projected estimates the completed matchup total.',
          'Different players can be in different matchup numbers because NHL team schedules do not move at the same pace.',
          'A matchup finalizes automatically only after every required roster spot completes its six-game count.',
        ],
      };
    }

    if (url.includes('/playoffs')) {
      return {
        id: 'playoffs',
        title: 'Road to the RinkRat Cup',
        subtitle: 'Playoff destinations can resolve after some NHL games have already happened.',
        tips: [
          'Already-played games are banked rather than discarded.',
          'When the prior round resolves, banked games are assigned to the correct championship or placement matchup.',
          'Every team receives a final placement through the championship and consolation structure.',
        ],
      };
    }

    if (url.includes('/standings')) {
      return {
        id: 'standings',
        title: 'League Standings',
        subtitle: 'Completed matchups update records and playoff position automatically.',
        tips: [
          'Points For and Points Against explain more than record alone.',
          'The playoff line shows the current qualification boundary.',
          'Standings apply only after a matchup has finalized, never from partial live scores.',
        ],
      };
    }

    if (/\/leagues\/[^/]+\/players\/[^/]+$/.test(url)) {
      return {
        id: 'player-intel',
        title: 'Player Intel',
        subtitle: 'Current production, league ownership, ranks, and next-six outlook.',
        tips: [
          'Overall rank compares every draftable asset; position rank compares the player with the same exact position.',
          'Watching is a private reminder. It does not add, claim, queue, reserve, or draft the player.',
        ],
      };
    }

    if (/\/leagues\/[^/]+\/players$/.test(url)) {
      return {
        id: 'player-board',
        title: 'Players',
        subtitle: 'Search rostered, available, waiver, unavailable, and watched assets.',
        tips: [
          'Open Player Intel for current stats, position and overall ranks, and the next-six outlook.',
          'Unavailable means the player is involved in a pending league move; the destination stays private until completion.',
        ],
      };
    }

    if (url.includes('/leaders')) {
      return {
        id: 'point-leaders',
        title: 'Point Leaders',
        subtitle: 'Completed six-game scoring windows ranked by fantasy points.',
        tips: [
          'Point Leaders uses finalized window totals rather than projections or partial live scores.',
          'Open a player for current-season context, ownership, and next-six ranks.',
        ],
      };
    }

    if (url === '/dashboard') {
      return {
        id: 'dashboard',
        title: 'Manager Home',
        subtitle: 'Choose a league or create your next competition.',
        tips: [
          'Your favorite NHL team controls the global arena accent, not your league-specific manager icon.',
          'Each league can have a different team name, profile picture, and selected team identity.',
          'New to RinkRat? Training Camp explains the full system in about three minutes.',
        ],
      };
    }

    if (/^\/leagues\/[^/]+$/.test(url)) {
      return {
        id: 'league_home',
        title: 'League Headquarters',
        subtitle: 'Your league’s current status, teams, draft, matchups, and commissioner tools live here.',
        tips: [
          'Your league profile picture can be changed from the Your Team identity card.',
          'Commissioner controls appear only for the league owner.',
          'Use the matchup links to follow scoring after the draft completes.',
        ],
      };
    }

    if (url.includes('/account/settings')) {
      return {
        id: 'account',
        title: 'Manager Preferences',
        subtitle: 'Personalize the arena without changing league-specific identities.',
        tips: [
          'Favorite-team or neutral RinkRat colors apply across the app, while each league keeps its own profile picture.',
          'Your Hockey Familiarity setting changes explanation detail without changing scoring or league rules.',
          'Challenge rewards unlock home, away, retro, and alternate identities for every NHL team.',
        ],
      };
    }

    return DEFAULT_GUIDE;
  }
}
