import { EventEmitter, Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class LoginService {
  showing = false;
  emitter = new EventEmitter<boolean>();

  isShowing(): boolean {
    return this.showing;
  }

  setShowing(showing: boolean): void {
    this.showing = showing;
    this.emitter.emit(showing);
  }
}
