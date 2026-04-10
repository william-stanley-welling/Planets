import { CelestialBody, RingConfig, StarConfig } from './celestial.model';

// Move StarStage enum here (or keep in this file, but export)
export enum StarStage {
  NEBULA = 'Nebula (Giant Gas Cloud)',
  PROTOSTAR = 'Protostar',
  T_TAURI_PHASE = 'T-Tauri Phase',
  MAIN_SEQUENCE = 'Main Sequence',
  RED_GIANT_OR_SUPERGIANT = 'Red Giant or Supergiant',
  STELLAR_DEATH_AND_REMNANTS = 'Stellar Death and Remnants',
}

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
  }
}
