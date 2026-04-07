import { CelestialBody, PlanetConfig } from "./planet.model";

/**
 * Enumeration for star evolutionary stage.
 * Each stage includes its canonical scientific description for reference.
 */
export enum StarStage {
  NEBULA = 'Nebula (Giant Gas Cloud)',
  PROTOSTAR = 'Protostar',
  T_TAURI_PHASE = 'T-Tauri Phase',
  MAIN_SEQUENCE = 'Main Sequence',
  RED_GIANT_OR_SUPERGIANT = 'Red Giant or Supergiant',
  STELLAR_DEATH_AND_REMNANTS = 'Stellar Death and Remnants',
}

/**
 * Data structure for star lifecycle.
 * Allows access to current stage at any simulation time `t` (mass-dependent).
 *
 * The life cycle of a star is a dynamic process influenced by mass and composition.
 * From nebula → protostar → main sequence → red giant/supergiant → stellar remnant,
 * each stage reflects changes in energy production, size, and structure.
 */
export interface StarLifecycleStageInfo {
  stage: StarStage;
  description: string;
}

export const STAR_LIFECYCLE_STAGES: StarLifecycleStageInfo[] = [
  {
    stage: StarStage.NEBULA,
    description: 'Stars begin as giant clouds of gas and dust, called nebulae or molecular clouds. Gravity causes these clouds to collapse, forming dense regions called cores. These cores attract more matter, increasing pressure and temperature, setting the stage for star formation.',
  },
  {
    stage: StarStage.PROTOSTAR,
    description: 'As the core collapses, it forms a protostar, a young star still gathering mass. The protostar emits energy from gravitational contraction rather than nuclear fusion. This phase can last hundreds of thousands to millions of years, during which the star spins rapidly and heats up.',
  },
  {
    stage: StarStage.T_TAURI_PHASE,
    description: 'Before nuclear fusion begins, the protostar enters the T-Tauri phase, characterized by strong stellar winds that blow away surrounding gas. The star’s brightness fluctuates as it seeks equilibrium between gravity and internal pressure.',
  },
  {
    stage: StarStage.MAIN_SEQUENCE,
    description: 'Once hydrogen fusion starts in the core, the star enters the main sequence, the longest stage of its life. Here, hydrogen fuses into helium, producing energy that balances gravitational collapse. The star’s mass determines its lifespan: low-mass stars can remain in this stage for trillions of years, while massive stars burn fuel rapidly and last only millions of years.',
  },
  {
    stage: StarStage.RED_GIANT_OR_SUPERGIANT,
    description: 'When hydrogen in the core is depleted, the star leaves the main sequence. The core contracts and heats up, while the outer layers expand and cool, forming a red giant (for low- to medium-mass stars) or supergiant (for massive stars). Helium and heavier elements fuse in the core, creating elements up to carbon or iron depending on the star’s mass.',
  },
  {
    stage: StarStage.STELLAR_DEATH_AND_REMNANTS,
    description: 'The final stage depends on the star’s mass: Low- to medium-mass stars shed outer layers as a planetary nebula, leaving behind a white dwarf, a dense, cooling remnant of the core. Massive stars may explode as a supernova, leaving a neutron star or, if massive enough, collapsing into a black hole.',
  },
];

export class StarLifecycle {
  /**
   * Returns the current star stage at simulation time `t`.
   * Durations are mass-dependent (placeholder implementation using normalized fractions).
   * Real implementation would scale total lifetime by mass using approximate stellar-evolution scaling:
   * Main-sequence lifetime ≈ 10¹⁰ × (M☉ / M)³·⁵ years.
   *
   * @param t Current simulation time
   * @param totalSimulationTime Total normalized simulation duration
   * @param mass Stellar mass (solar masses)
   */
  getStageAtTime(t: number, totalSimulationTime: number, mass: number): StarStage {
    const fraction = Math.min(Math.max(t / totalSimulationTime, 0), 1);

    // Approximate fractional durations (nebula/protostar short, main sequence dominant)
    if (fraction < 0.05) return StarStage.NEBULA;
    if (fraction < 0.12) return StarStage.PROTOSTAR;
    if (fraction < 0.18) return StarStage.T_TAURI_PHASE;
    if (fraction < 0.82) return StarStage.MAIN_SEQUENCE;
    if (fraction < 0.95) return StarStage.RED_GIANT_OR_SUPERGIANT;
    return StarStage.STELLAR_DEATH_AND_REMNANTS;
  }
}

export interface AdditionalStarProperties {
  composition?: string; // e.g. "74% hydrogen, 24% helium, 2% heavier elements"
  heat?: number; // surface temperature (Kelvin)
  energy?: number; // luminosity (solar luminosities L☉)
  radiance?: number; // radiant energy output / flux
}

export interface StarConfig extends PlanetConfig, AdditionalStarProperties {
  stage: StarStage;
}

/**
 * Star is the central fixed body (extends CelestialBody, does NOT implement Satellite).
 * Contains satellites (planets and moons) in a THREE.Group hierarchy for true heliocentric motion.
 */
export class Star extends CelestialBody {
  stage!: StarStage;
  composition?: string;
  heat?: number;
  energy?: number;
  radiance?: number;
  lifecycle?: StarLifecycle;

  constructor(prop: StarConfig) {
    super(prop);
    this.stage = prop.stage;
    this.composition = prop.composition;
    this.heat = prop.heat;
    this.energy = prop.energy;
    this.radiance = prop.radiance;
    this.lifecycle = new StarLifecycle();
  }
}
