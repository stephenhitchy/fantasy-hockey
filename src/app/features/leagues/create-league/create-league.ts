import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { auth } from '../../../core/firebase';
import { createLeague } from '../../../core/league/league.service';
import { getUserProfile } from '../../../core/user/user.service';
import { TelemetryService } from '../../../core/observability/telemetry.service';
import { TeamIdentityChallengeService } from '../../../core/user/team-identity-challenge.service';
import {
  DEFAULT_LEAGUE_LOGO_ID,
  DEFAULT_LEAGUE_LOGO_PALETTE_ID,
  getLeagueLogoAssetPath,
  LEAGUE_LOGO_OPTIONS,
  LEAGUE_LOGO_PALETTE_OPTIONS,
  LeagueLogoId,
  LeagueLogoPaletteId,
} from '../../../shared/league-logo/league-logo.data';

@Component({
  selector: 'app-create-league',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './create-league.html',
  styleUrl: './create-league.css'
})
export class CreateLeague {
  name = '';
  maxTeams = 6;
  selectedLogoId = signal<LeagueLogoId>(DEFAULT_LEAGUE_LOGO_ID);
  selectedPaletteId = signal<LeagueLogoPaletteId>(DEFAULT_LEAGUE_LOGO_PALETTE_ID);
  errorMessage = signal('');
  loading = signal(false);

  readonly teamOptions = computed(() => Array.from({ length: 11 }, (_, index) => index + 2));
  readonly logoOptions = LEAGUE_LOGO_OPTIONS;
  readonly paletteOptions = LEAGUE_LOGO_PALETTE_OPTIONS;
  readonly selectedLogoPath = computed(() =>
    getLeagueLogoAssetPath(this.selectedLogoId(), this.selectedPaletteId()),
  );
  readonly selectedLogoOption = computed(
    () =>
      this.logoOptions.find((option) => option.id === this.selectedLogoId()) ??
      this.logoOptions[0]!,
  );

  constructor(
    private router: Router,
    private telemetry: TelemetryService,
    private challengeService: TeamIdentityChallengeService,
  ) {}

  async submit(): Promise<void> {
    this.errorMessage.set('');
    this.loading.set(true);

    try {
      const user = auth.currentUser;

      if (!user) {
        throw new Error('You must be logged in.');
      }

      const profile = await getUserProfile(user.uid);
      const username = profile?.username || user.email || 'Unknown User';
      await createLeague(
        this.name,
        this.maxTeams,
        username,
        this.selectedLogoId(),
        this.selectedPaletteId(),
      );
      this.telemetry.track('league_created', { max_teams: this.maxTeams });
      void this.challengeService.refresh(user.uid, { force: true });
      await this.router.navigate(['/dashboard']);
    } catch (error: any) {
      this.errorMessage.set(error?.message || 'Unable to create the league right now.');
    } finally {
      this.loading.set(false);
    }
  }

  selectLogo(logoId: LeagueLogoId): void {
    this.selectedLogoId.set(logoId);
  }

  selectPalette(paletteId: LeagueLogoPaletteId): void {
    this.selectedPaletteId.set(paletteId);
  }

  getLogoPath(logoId: LeagueLogoId): string {
    return getLeagueLogoAssetPath(logoId, this.selectedPaletteId());
  }

  getPalettePreviewPath(paletteId: LeagueLogoPaletteId): string {
    return getLeagueLogoAssetPath(this.selectedLogoId(), paletteId);
  }
}
