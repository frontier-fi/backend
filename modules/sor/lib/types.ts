import { PathGraphTraversalConfig } from './pathGraph/pathGraphTypes';

export enum PoolType {
    AaveLinear = 'AaveLinear',
    ComposableStable = 'ComposableStable',
    CowAmm = 'CowAmm',
    Fx = 'FX',
    Gyro2 = 'Gyro2',
    Gyro3 = 'Gyro3',
    GyroE = 'GyroE',
    MetaStable = 'MetaStable',
    Stable = 'Stable',
    StableSurge = 'StableSurge',
    Weighted = 'Weighted',
    ReClamm = 'ReClamm',
    LiquidityBootstrapping = 'LiquidityBootstrapping',
    LiquidityBootstrappingFixedPrice = 'LiquidityBootstrappingFixedPrice',
}

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
