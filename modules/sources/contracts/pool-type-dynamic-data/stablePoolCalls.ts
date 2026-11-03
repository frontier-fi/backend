import { AbiParametersToPrimitiveTypes, ExtractAbiFunction } from 'abitype';
import { ViemMulticallCall } from '../../../web3/multicaller-viem';
import stableV3 from '../abis/stable-v3';
import { formatEther, formatUnits } from 'viem';

type AmplificationParameters = AbiParametersToPrimitiveTypes<
    ExtractAbiFunction<typeof stableV3, 'getAmplificationParameter'>['outputs']
>;
type AmplificationState = AbiParametersToPrimitiveTypes<
    ExtractAbiFunction<typeof stableV3, 'getAmplificationState'>['outputs']
>;
type GetRate = AbiParametersToPrimitiveTypes<ExtractAbiFunction<typeof stableV3, 'getRate'>['outputs']>[0];

const formatAmpValue = (rawValue: bigint, precision: bigint): string => {
    const decimals = precision > 0n ? Math.round(Math.log10(Number(precision))) : 3;
    return formatUnits(rawValue, decimals);
};

export const stableContractCalls = (id: string): ViemMulticallCall[] => [
    {
        path: `${id}.pool.typeData`,
        address: id as `0x${string}`,
        abi: stableV3,
        functionName: 'getAmplificationParameter',
        parser: (result: AmplificationParameters) => ({
            amp: String(result[0] / result[2]),
            ampIsUpdating: result[1],
        }),
    },
    {
        path: `${id}.pool.typeData`,
        address: id as `0x${string}`,
        abi: stableV3,
        functionName: 'getAmplificationState',
        parser: (result: AmplificationState) => {
            const [state, precision] = result;
            return {
                ampStartValue: formatAmpValue(BigInt(state.startValue), precision),
                ampEndValue: formatAmpValue(BigInt(state.endValue), precision),
                ampStartTime: String(state.startTime),
                ampEndTime: String(state.endTime),
            };
        },
    },
    {
        path: `${id}.pool.typeData.bptPriceRate`,
        address: id as `0x${string}`,
        abi: stableV3,
        functionName: 'getRate',
        parser: (result: GetRate) => formatEther(result),
    },
];
