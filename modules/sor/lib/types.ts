import { PathGraphTraversalConfig } from './pathGraph/pathGraphTypes';

interface FundManagement {
    sender: string;
    fromInternalBalance: boolean;
    recipient: string;
    toInternalBalance: boolean;
}

export interface SorSwapOptions {
    currentTimestamp?: bigint;
    slippage?: bigint;
    funds?: FundManagement;
    deadline?: bigint;
    minSplitBenefitBps?: bigint;
    graphTraversalConfig?: Partial<PathGraphTraversalConfig>;
}
