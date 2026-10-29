import { Chain } from '@prisma/client';
import config from '../../../config';

export const githubChainToChain: { [chain: string]: Chain } = {
    ...('MAINNET' in config ? { ethereum: 'MAINNET' as Chain } : {}),
    ...Object.fromEntries(Object.keys(config).map((chain) => [chain.toLowerCase(), chain as Chain])),
};
