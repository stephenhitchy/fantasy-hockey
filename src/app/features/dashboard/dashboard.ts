import { Component, signal } from '@angular/core';
import { Router } from '@angular/router';
import { auth } from '../../core/firebase';
import { logoutUser } from '../../core/auth/auth.service';

@Component({
  selector: 'app-dashboard',
  imports: [],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class Dashboard {
  email = signal(auth.currentUser?.email ?? '');

  constructor(private router: Router) {}

  async logout() {
    await logoutUser();
    await this.router.navigate(['/']);
  }
}