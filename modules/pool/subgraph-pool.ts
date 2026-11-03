import { parseUnits } from 'viem';
import type { TypePoolFragment } from '../sources/subgraphs/pools/generated/types';

type WithoutTypename<T> = Omit<T, '__typename'>;

type Params<K extends keyof TypePoolFragment> = WithoutTypename<NonNullable<TypePoolFragment[K]>>;

export type EclpData = Params<'eclpParams'>;
export type StableParams = Params<'stableParams'>;
export type WeightedParams = Params<'weightedParams'>;

export type StableRampFields = {
    ampIsUpdating?: boolean | null;
    ampStartValue?: string | null;
    ampEndValue?: string | null;
    ampStartTime?: string | null;
    ampEndTime?: string | null;
};

export type StableData = StableParams & StableRampFields & { bptPriceRate: string };

const AMP_PRECISION = 1000n;

/**
 * Computes the current amplification parameter scaled by AMP_PRECISION (1e3), matching
 * StablePool._getAmplificationParameter() on-chain and @balancer-labs/balancer-maths.
 */
export function computeStableAmp(
    stableData: Pick<StableData, 'amp'> & Partial<StableRampFields>,
    currentTimestamp?: bigint,
): bigint {
    const fallbackAmp = parseUnits(String(stableData.amp), 3);

    if (
        stableData.ampIsUpdating === false ||
        stableData.ampStartValue == null ||
        stableData.ampEndValue == null ||
        stableData.ampStartTime == null ||
        stableData.ampEndTime == null
    ) {
        return fallbackAmp;
    }

    const startTime = BigInt(stableData.ampStartTime);
    const endTime = BigInt(stableData.ampEndTime);

    if (endTime <= 0n || endTime <= startTime) {
        return fallbackAmp;
    }

    const startValue = parseUnits(String(stableData.ampStartValue), 3);
    const endValue = parseUnits(String(stableData.ampEndValue), 3);
    const now = currentTimestamp ?? BigInt(Math.floor(Date.now() / 1000));

    if (now >= endTime) {
        return endValue;
    }
    if (now <= startTime) {
        return startValue;
    }

    const elapsed = now - startTime;
    const duration = endTime - startTime;
    if (endValue > startValue) {
        return startValue + ((endValue - startValue) * elapsed) / duration;
    }
    return startValue - ((startValue - endValue) * elapsed) / duration;
}

export function resolveStableAmp(
    stableData: Pick<StableData, 'amp'> & Partial<StableRampFields>,
    currentTimestamp?: bigint,
): string {
    return String(computeStableAmp(stableData, currentTimestamp) / AMP_PRECISION);
}
