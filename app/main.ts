/// <reference types="@angular/localize" />

import { environment } from './environments/environment';

import { provideHttpClient } from '@angular/common/http';
import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, RouterLink, RouterOutlet, Routes } from '@angular/router';

import { APP_CONFIG } from './app.config';
import { DashboardComponent } from './dashboard.component';
import { PlanetFactory } from './galaxy/planet.factory';
import { HomeComponent } from './home.component';
import { LoginComponent } from './login.component';
import { LoginDirective } from './login.directive';
import { LoginService } from './login.service';
import { RegisterComponent } from './register.component';
import { HttpService } from './utils/http.service';
import { SseService } from './utils/sse.service';
import { WebSocketService } from './utils/websocket.service';
import { TextureService } from './webgl/texture.service';
import { WebGl } from './webgl/webgl.service';

const routes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  { path: 'home', component: HomeComponent },
  { path: 'register', component: RegisterComponent },
  { path: 'login', component: LoginComponent },
  { path: 'dashboard', component: DashboardComponent }
];

@Component({
  selector: 'ts-app',
  standalone: true,
  imports: [RouterLink, RouterOutlet, LoginComponent, LoginDirective],
  template: `
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
      <div class="container-fluid">
        <a class="navbar-brand" routerLink="/home">Planets</a>
        <div class="collapse navbar-collapse" id="navNav">
          <ul class="navbar-nav me-auto">
            <li class="nav-item"><a class="nav-link" routerLink="/home">Home</a></li>
            <li class="nav-item"><a class="nav-link" routerLink="/dashboard">Dashboard</a></li>
          </ul>
          <ul class="navbar-nav">
            <li class="nav-item"><a class="nav-link" routerLink="/register">Register</a></li>
            <li class="nav-item">
              <a class="nav-link" loginClick style="cursor:pointer">Login</a>
            </li>
          </ul>
        </div>
      </div>
    </nav>
    <login></login>
    <router-outlet></router-outlet>
  `
})
export class AppComponent { }

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(routes),
    provideHttpClient(),
    {
      provide: APP_CONFIG,
      useValue: {
        wsUrl: environment.wsUrl,
        sseUrl: environment.sseUrl
      }
    },
    WebGl,
    LoginService,
    HttpService,
    SseService,
    WebSocketService,
    TextureService,
    PlanetFactory
  ]
}).catch(err => console.error(err));
