import { OrbitingBody, PlanetConfig } from './celestial.model';

export class Planet extends OrbitingBody {
  constructor(config: PlanetConfig) {
    super(config);
  }
}

// Re-export commonly used items
export { PlanetConfig, SIMULATION_CONSTANTS } from './celestial.model';
