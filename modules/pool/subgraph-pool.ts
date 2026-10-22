import type { TypePoolFragment } from '../sources/subgraphs/pools/generated/types';

type WithoutTypename<T> = Omit<T, '__typename'>;

type Params<K extends keyof TypePoolFragment> = WithoutTypename<NonNullable<TypePoolFragment[K]>>;

export type GyroEParams = Params<'gyroEParams'>;
export type StableParams = Params<'stableParams'>;
export type WeightedParams = Params<'weightedParams'>;

export type GyroData = GyroEParams;
export type StableData = StableParams & { bptPriceRate: string };
