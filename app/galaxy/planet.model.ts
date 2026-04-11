import { OrbitingBody, PlanetConfig, RingConfig } from './celestial.model';

/* ~AI PROMPT~: Add more properties to the planet model, such as atmospheric composition, surface temperature, and habitability index. These can be used to determine the planet's appearance and potential for supporting life in the simulation. Update in appropriate factory to utilize property and update rendering. */
export class Planet extends OrbitingBody {
  rings?: RingConfig[];
  constructor(config: PlanetConfig) {
    super(config);
    this.rings = config.rings;
  }
}

// ~AI PROMPT~ Explain why these are here and if they should be? Who said importing the planet comes with its initial configuration? Configuration are not perceivable and destroy after use in constructor. Violation of large objects, large objects dont keep track of smaller objects allowed in constructor.
// Re-export commonly used items
export { PlanetConfig, SIMULATION_CONSTANTS } from './celestial.model';

