import { InjectionToken } from '@angular/core';

export interface AppConfig {
  wsUrl: string;
  sseUrl: string;
}

export const APP_CONFIG = new InjectionToken<AppConfig>('app.config');
