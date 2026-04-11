import { CelestialBody, RingConfig, StarConfig } from './celestial.model';

// Move StarStage enum here (or keep in this file, but export)

// ~AI PROMPT~ Implement the gemoetric structure to accomplish this from large images from NASA observatories. No bullshit, I want the manifold surfaces generated. Input image. Output same as "Planets" input files for initial state. I want this to build itself while slackers find and import images.
// ~AI PROMPT~ Implement an Angular @Service that transforms celestial bodies into stars and stars through its stages of its lifecycle called lifecycle.factory.ts. It is to interface with webgl.interface.ts to implement the visual effects.
export enum StarStage {
  NEBULA = 'Nebula (Giant Gas Cloud)',
  PROTOSTAR = 'Protostar',
  T_TAURI_PHASE = 'T-Tauri Phase',
  MAIN_SEQUENCE = 'Main Sequence',
  RED_GIANT_OR_SUPERGIANT = 'Red Giant or Supergiant',
  STELLAR_DEATH_AND_REMNANTS = 'Stellar Death and Remnants',
}
// ~AI PROMPT~: Add more properties to the star model, such as luminosity, temperature, and spectral type. These can be used to determine the star's color and brightness in the simulation. Update in appropriate factory to utilize property and update rendering.
export class Star extends CelestialBody {
  stage: StarStage;
  rings?: RingConfig[];
  composition?: string;
  heat?: number;
  energy?: number;
  radiance?: number;

  constructor(config: StarConfig) {
    super(config);
    this.stage = config.stage;
    this.composition = config.composition;
    this.heat = config.heat;
    this.energy = config.energy;
    this.radiance = config.radiance;
    this.rings = config.rings;
  }
}
