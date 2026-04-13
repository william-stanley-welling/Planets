import { OrbitingBody, PlanetConfig, RingConfig } from './celestial.model';

export class Planet extends OrbitingBody {
  rings?: RingConfig[];
  constructor(config: PlanetConfig) {
    super(config);
    this.rings = config.rings;
  }
}

export { PlanetConfig, SIMULATION_CONSTANTS } from './celestial.model';

