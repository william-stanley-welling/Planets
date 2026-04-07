import { Directive, HostListener, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { LoginService } from './login.service';

@Directive({
  selector: '[loginClick]',
  standalone: true
})
export class LoginDirective implements OnInit {
  private open = false;
  private sub: Subscription;

  constructor(private loginService: LoginService) {

  }

  ngOnInit(): void {
    this.sub = this.loginService.emitter.subscribe((showing: boolean) => {
      this.open = showing;
    });
  }

  @HostListener('click')
  onMouseClick(): void {
    this.open = !this.open;
    this.loginService.setShowing(this.open);
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
