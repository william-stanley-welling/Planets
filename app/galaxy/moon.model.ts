import * as THREE from 'three';
import { MoonConfig, OrbitingBody } from './celestial.model';

// Re-export MoonConfig for convenience? Does this have to be here?
export { MoonConfig };

export enum LunarPhase {
  NEW_MOON = 'New Moon',
  WAXING_CRESCENT = 'Waxing Crescent',
  FIRST_QUARTER = 'First Quarter',
  WAXING_GIBBOUS = 'Waxing Gibbous',
  FULL_MOON = 'Full Moon',
  WANING_GIBBOUS = 'Waning Gibbous',
  LAST_QUARTER = 'Last Quarter',
  WANING_CRESCENT = 'Waning Crescent',
}

export function lunarPhaseFromAngle(phaseAngleRad: number): LunarPhase {
  const a = ((phaseAngleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const deg = (a * 180) / Math.PI;
  if (deg < 22.5 || deg >= 337.5) return LunarPhase.NEW_MOON;
  if (deg < 67.5) return LunarPhase.WAXING_CRESCENT;
  if (deg < 112.5) return LunarPhase.FIRST_QUARTER;
  if (deg < 157.5) return LunarPhase.WAXING_GIBBOUS;
  if (deg < 202.5) return LunarPhase.FULL_MOON;
  if (deg < 247.5) return LunarPhase.WANING_GIBBOUS;
  if (deg < 292.5) return LunarPhase.LAST_QUARTER;
  return LunarPhase.WANING_CRESCENT;
}

export class Moon extends OrbitingBody {
  readonly resource?: string;

  constructor(config: MoonConfig) {
    super(config);
    this.resource = config.resource;
    if (!config.au && !config.relativeAu) {
      // console.warn(`Moon "${config.name}" has no au or relativeAu — default radius used.`);
    }
  }

  getLunarPhase(starWorldPosition: THREE.Vector3 = new THREE.Vector3()): LunarPhase {
    const moonWorld = new THREE.Vector3();
    this.group.getWorldPosition(moonWorld);
    const toStar = starWorldPosition.clone().sub(moonWorld).normalize();
    const phaseAngle = Math.atan2(toStar.z, toStar.x);
    return lunarPhaseFromAngle(phaseAngle);
  }
}
