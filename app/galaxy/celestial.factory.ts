import { CelestialBody, PlanetConfig } from './celestial.model';

/**
 * Generic factory for creating celestial bodies.
 * Concrete factories must implement `build(bodyData: T): Promise<U>`.
 *
 * @template T The raw JSON data shape (usually any, but could be typed).
 * @template U The constructed CelestialBody subclass.
 */
export abstract class CelestialFactory<T, U extends CelestialBody> {
  abstract build(bodyData: T): Promise<U>;
}
