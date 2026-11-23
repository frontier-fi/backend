import { Chain } from '@prisma/client';
import { NetworkData } from './types';
import sepoliaConfig from './sepolia';
import baseConfig from './base';
import ethereumConfig from './ethereum';
import monadConfig from './monad';

export const DAYS_OF_HOURLY_PRICES = 100;
export const BALANCES_SYNC_BLOCKS_MARGIN = 200;

const networks: { [chain: string]: NetworkData } = {
    [Chain.SEPOLIA]: sepoliaConfig,
    [Chain.BASE]: baseConfig,
    [Chain.MAINNET]: ethereumConfig,
    [Chain.MONAD]: monadConfig,
};

export default networks;
