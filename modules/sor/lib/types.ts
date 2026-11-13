import { PathGraphTraversalConfig } from './pathGraph/pathGraphTypes';

export interface SorSwapOptions {
    currentTimestamp?: bigint;
    minSplitBenefitBps?: bigint;
    graphTraversalConfig?: Partial<PathGraphTraversalConfig>;
}
