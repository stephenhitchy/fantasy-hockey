import { Component } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { logoutUser } from '../../core/auth/auth.service';

@Component({
  selector: 'app-navbar',
  imports: [RouterLink],
  templateUrl: './navbar.html',
  styleUrl: './navbar.css'
})
export class Navbar {
  constructor(private router: Router) {}

  async logout() {
    await logoutUser();
    await this.router.navigate(['/']);
  }
}