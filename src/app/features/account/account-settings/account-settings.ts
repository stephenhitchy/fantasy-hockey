import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { auth } from '../../../core/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  getUserProfile,
  updateUsername,
  UserProfile
} from '../../../core/user/user.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-account-settings',
  imports: [FormsModule],
  templateUrl: './account-settings.html',
  styleUrl: './account-settings.css'
})
export class AccountSettings {
  profile = signal<UserProfile | null>(null);
  username = '';
  loading = signal(true);
  saving = signal(false);
  successMessage = signal('');
  errorMessage = signal('');

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

  this.profile.set(profile);
  this.username = profile?.username ?? '';
  this.loading.set(false);
  }

  async saveUsername() {
    this.successMessage.set('');
    this.errorMessage.set('');

    const user = auth.currentUser;

    if (!user) {
      this.errorMessage.set('You must be logged in.');
      return;
    }

    if (!this.username.trim()) {
      this.errorMessage.set('Username cannot be empty.');
      return;
    }

    this.saving.set(true);

    try {
      await updateUsername(user.uid, this.username.trim());
      this.successMessage.set('Username updated!');
    } catch (error: any) {
      this.errorMessage.set(error.message);
    } finally {
      this.saving.set(false);
    }
  }
}