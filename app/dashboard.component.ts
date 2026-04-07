import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, HostListener } from '@angular/core';
import { WebGl } from './webgl/webgl.service';

@Component({
  selector: 'dashboard',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    #content {
      position: relative;
      width: 100%;
      height: 100vh;
      overflow: hidden;
    }
    .hud-hint {
      position: absolute;
      bottom: 1.5rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.7);
      color: #fff;
      padding: 0.6rem 1.4rem;
      border-radius: 6px;
      font-size: 0.95rem;
      pointer-events: none;
      z-index: 100;
    }
  `],
  template: `
    <div id="content" (click)="onContentClick()">
      <span class="hud-hint">
        {{ webGl.controls?.locked
            ? 'FLIGHT MODE ACTIVE — ESC or Space to exit • WASD move • R/F up/down • Mouse to look'
            : 'Click anywhere in the 3D view or press Space to enter flight mode' }}
      </span>
    </div>
  `
})
export class DashboardComponent implements AfterViewInit {

  constructor(
    public elementRef: ElementRef,
    public webGl: WebGl
  ) { }

  onContentClick() {
    if (!this.webGl.controls?.locked) {
      this.webGl.controls?.enterFlight();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    this.webGl.keyDown(event);
  }

  @HostListener('window:resize', ['$event'])
  onResize(event?: any) {
    const container = this.elementRef.nativeElement.querySelector('#content');
    if (container) {
      this.webGl.resize(container.clientHeight, container.clientWidth);
    }
  }

  ngAfterViewInit() {
    const container = this.elementRef.nativeElement.querySelector('#content');
    const rendererEl = this.webGl.getRenderer().domElement;

    container.appendChild(rendererEl);
    rendererEl.style.width = '100%';
    rendererEl.style.height = '100%';

    if (!this.webGl.isActive()) {
      this.webGl.init(container.clientHeight, container.clientWidth);
      this.webGl.start();
    }

    this.onResize();
  }
}
