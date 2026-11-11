import { BufferState, PoolState } from '@frontier-fi/maths';
import { BasePool } from '../basePool';
import { BasePoolToken } from '../utils';

export interface BasePoolMethodsV3 extends BasePool {
    tokens: BasePoolToken[];
    getPoolState(): PoolState | BufferState;
}
