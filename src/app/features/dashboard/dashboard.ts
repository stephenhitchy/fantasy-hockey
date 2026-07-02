import { Component, signal } from '@angular/core';
import { Router } from '@angular/router';
import { auth } from '../../core/firebase';
import { logoutUser } from '../../core/auth/auth.service';
import { getUserProfile, UserProfile } from '../../core/user/user.service';
import { RouterLink } from '@angular/router';
import { getMyLeagues, League } from '../../core/league/league.service';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})

export class Dashboard {
  leagues = signal<League[]>([]);
  profile = signal<UserProfile | null>(null);
  loading = signal(true);

  constructor(private router: Router) {
    this.loadProfile();
  }

  async loadProfile() {
  const user = auth.currentUser;

  if (!user) {
    await this.router.navigate(['/']);
    return;
  }

  const profile = await getUserProfile(user.uid);
  const leagues = await getMyLeagues();

  this.profile.set(profile);
  this.leagues.set(leagues);
  this.loading.set(false);
}

  async logout() {
    await logoutUser();
    await this.router.navigate(['/']);
  }
}