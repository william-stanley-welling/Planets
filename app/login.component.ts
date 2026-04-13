import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LoginService } from './login.service';

@Component({
  selector: 'login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    .login-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.85);
      z-index: 3000;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .login-card {
      background: #1a1a1a;
      padding: 2.5rem;
      border-radius: 12px;
      border: 1px solid #333;
      color: white;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.8);
    }
    .social-header {
      text-align: center;
      margin-bottom: 1rem;
      font-size: 0.9rem;
      color: #888;
    }
    .social-links {
      display: flex;
      gap: 10px;
      justify-content: center;
      margin-bottom: 2rem;
    }
    .form-label { color: #aaa; font-size: 0.85rem; }
    .form-control {
      background-color: #2a2a2a !important;
      border-color: #444 !important;
      color: white !important;
    }
    .form-control::placeholder { color: #666; }
  `],
  template: `
    <div class="login-overlay" *ngIf="showing">
      <div class="login-card">
        <h4 class="mb-4 text-center">Sign In</h4>
        
        <div class="social-header">Login with Social</div>
        <div class="social-links">
          <a href="/auth/google" class="btn btn-outline-secondary btn-sm"><i class="bi bi-google"></i></a>
          <a href="/auth/linkedin" class="btn btn-outline-secondary btn-sm"><i class="bi bi-linkedin"></i></a>
          <a href="/auth/github" class="btn btn-outline-secondary btn-sm"><i class="bi bi-github"></i></a>
          <a href="/auth/microsoft" class="btn btn-outline-secondary btn-sm"><i class="bi bi-microsoft"></i></a>
          <a href="/auth/twitter" class="btn btn-outline-secondary btn-sm"><i class="bi bi-twitter-x"></i></a>
        </div>

        <form (ngSubmit)="onSubmit()">
          <div class="mb-3">
            <label class="form-label">Email Address</label>
            <input type="email" class="form-control" placeholder="name@example.com" autofocus>
          </div>
          
          <div class="mb-4">
            <label class="form-label">Password</label>
            <input type="password" class="form-control" placeholder="••••••••">
          </div>

          <div class="d-grid gap-2">
            <button type="submit" class="btn btn-primary">Log In</button>
            <button type="button" class="btn btn-link text-warning" (click)="onCancel()">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `
})
export class LoginComponent {

  showing = false;

  constructor(private loginService: LoginService) {
    this.loginService.emitter.subscribe(s => this.showing = s);
  }

  onSubmit() { this.loginService.setShowing(false); }

  onCancel() { this.loginService.setShowing(false); }
}
