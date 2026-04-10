import { CelestialBody, PlanetConfig } from './celestial.model';

export enum StarStage {
  NEBULA = 'Nebula (Giant Gas Cloud)',
  PROTOSTAR = 'Protostar',
  T_TAURI_PHASE = 'T-Tauri Phase',
  MAIN_SEQUENCE = 'Main Sequence',
  RED_GIANT_OR_SUPERGIANT = 'Red Giant or Supergiant',
  STELLAR_DEATH_AND_REMNANTS = 'Stellar Death and Remnants',
}

export interface AdditionalStarProperties {
  composition?: string;
  heat?: number;
  energy?: number;
  radiance?: number;
}

export interface StarConfig extends PlanetConfig, AdditionalStarProperties {
  stage: StarStage;
}

export class Star extends CelestialBody {
  stage!: StarStage;
  composition?: string;
  heat?: number;
  energy?: number;
  radiance?: number;

  constructor(prop: StarConfig) {
    super(prop);
    this.stage = prop.stage;
    this.composition = prop.composition;
    this.heat = prop.heat;
    this.energy = prop.energy;
    this.radiance = prop.radiance;
  }
}
