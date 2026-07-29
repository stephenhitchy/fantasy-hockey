import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

@Component({
  selector: 'app-access-denied',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './access-denied.html',
  styleUrl: './access-denied.css',
})
export class AccessDenied {
  private readonly route = inject(ActivatedRoute);
  private readonly reason = this.route.snapshot.queryParamMap.get('reason') ?? '';
  readonly leagueId = this.route.snapshot.queryParamMap.get('leagueId') ?? '';

  readonly title = computed(() => {
    if (this.reason === 'commissioner') {
      return 'Commissioner Access Required';
    }

    if (this.reason === 'developer-tools') {
      return 'Developer Tool Hidden';
    }

    return 'This Rink Is Restricted';
  });

  readonly message = computed(() => {
    if (this.reason === 'commissioner') {
      return 'Only the commissioner of this league can open that control panel.';
    }

    if (this.reason === 'developer-tools') {
      return 'That diagnostic page is disabled in the production version of RinkRat.';
    }

    if (this.reason === 'league-check' || this.reason === 'commissioner-check') {
      return 'RinkRat could not verify access to that league. Refresh and try again from your Dashboard.';
    }

    return 'You are not currently a member of that league, or the league no longer exists.';
  });
}
