/**
 * Ambient module declaration for `fastnoise-lite` (KTD2).
 *
 * The npm package ships as plain ESM JavaScript with no TypeScript
 * declarations. This covers only the subset of the API `fields.ts` actually
 * calls — a seeded noise instance producing 2D OpenSimplex2 samples in
 * [-1, 1] — rather than transcribing the library's full surface.
 */
declare module 'fastnoise-lite' {
  export default class FastNoiseLite {
    constructor(seed?: number);
    static readonly NoiseType: {
      readonly OpenSimplex2: string;
      readonly OpenSimplex2S: string;
      readonly Cellular: string;
      readonly Perlin: string;
      readonly ValueCubic: string;
      readonly Value: string;
    };
    SetSeed(seed: number): void;
    SetFrequency(frequency: number): void;
    SetNoiseType(noiseType: string): void;
    /** 2D noise at (x, y) using current settings. Bounded in [-1, 1]. */
    GetNoise(x: number, y: number): number;
  }
}
