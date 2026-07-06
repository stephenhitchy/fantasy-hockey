import { Component, signal } from '@angular/core';
import { Router } from '@angular/router';
import { auth } from '../../core/firebase';
import { logoutUser } from '../../core/auth/auth.service';
import { getUserProfile, UserProfile } from '../../core/user/user.service';
import { RouterLink } from '@angular/router';
import { getMyLeagueSummaries, LeagueSummary } from '../../core/league/league.service';
import { onAuthStateChanged, User } from 'firebase/auth';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})

export class Dashboard {
  leagueSummaries = signal<LeagueSummary[]>([]);
  profile = signal<UserProfile | null>(null);
  loading = signal(true);

  constructor(private router: Router) {
    this.loadProfile();
  }

  async loadProfile() {
  const user = await waitForAuthUser();

  if (!user) {
    await this.router.navigate(['/']);
    return;
  }

  const profile = await getUserProfile(user.uid);
  const leagueSummaries = await getMyLeagueSummaries();

  this.profile.set(profile);
  this.leagueSummaries.set(leagueSummaries);
  this.loading.set(false);
}

  async logout() {
    await logoutUser();
    await this.router.navigate(['/']);
  }
}