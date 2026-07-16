import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import {
  CycleSimulationReport,
  runDeterministicCycleWindowSimulation
} from '../../../core/cycle/cycle-window-simulator';
import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-cycle-simulator',
  imports: [RouterLink],
  templateUrl: './cycle-simulator.html',
  styleUrl: './cycle-simulator.css'
})
export class CycleSimulator {
  leagueId = '';
  league = signal<League | null>(null);
  report = signal<CycleSimulationReport>(
    runDeterministicCycleWindowSimulation()
  );
  loading = signal(true);
  errorMessage = signal('');

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    void this.loadPage();
  }

  rerunSimulation(): void {
    this.report.set(runDeterministicCycleWindowSimulation());
  }

  private async loadPage(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;

    try {
      const league = await getLeagueById(leagueId);

      if (!league) {
        throw new Error('League not found.');
      }

      if (league.commissionerId !== user.uid) {
        throw new Error('Only the commissioner can open development tests.');
      }

      this.league.set(league);
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to open the cycle simulator.'
      );
    } finally {
      this.loading.set(false);
    }
  }
}
