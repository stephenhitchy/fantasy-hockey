import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { loginUser, registerUser } from '../../core/auth/auth.service';
import { Router } from '@angular/router';


@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './auth.html',
  styleUrl: './auth.css'
})
export class Auth {
  email = '';
  password = '';
  username = '';
  isRegistering = signal(false);
  errorMessage = signal('');
  successMessage = signal('');

  async submit() {
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      if (this.isRegistering()) {
        await registerUser(this.email, this.password, this.username);
        this.successMessage.set('Account created successfully!');
      } else {
        await loginUser(this.email, this.password);
        this.successMessage.set('Logged in successfully!');
      }
      await this.router.navigate(['/dashboard']);
    } catch (error: any) {
      this.errorMessage.set(error.message);
    }
  }

  toggleMode() {
    this.isRegistering.set(!this.isRegistering());
    this.errorMessage.set('');
    this.successMessage.set('');
  }

  constructor(private router: Router) {}

  
}