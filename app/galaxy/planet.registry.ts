import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class PlanetRegistry {
  private readonly _planets = new BehaviorSubject<any[]>([]);

  public readonly planets$ = this._planets.asObservable();

  addPlanet(planetData: any): void {
    const current = this._planets.getValue();
    const exists = current.find((p) => p.name === planetData.name);

    if (!exists) {
      this._planets.next([...current, planetData]);
    }
  }

  getRawPlanets(): any[] {
    return this._planets.getValue();
  }

  clear(): void {
    this._planets.next([]);
  }
}
