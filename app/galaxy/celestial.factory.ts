import { CelestialBody, CelestialConfig } from './celestial.model';

/**
 * Generic factory for creating celestial bodies from a configuration object.
 * @template T The configuration type (must extend CelestialConfig).
 * @template U The constructed CelestialBody subclass.
 */
export abstract class CelestialFactory<T extends CelestialConfig, U extends CelestialBody> {
  abstract build(config: T): Promise<U>;
}
