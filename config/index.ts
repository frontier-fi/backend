import { Chain } from '@prisma/client';
import { NetworkData } from './types';
import sepoliaConfig from './sepolia';
import baseConfig from './base';

export const DAYS_OF_HOURLY_PRICES = 100;
export const BALANCES_SYNC_BLOCKS_MARGIN = 200;

const networks: { [chain: string]: NetworkData } = {
    [Chain.SEPOLIA]: sepoliaConfig,
    [Chain.BASE]: baseConfig,
};

export default networks;
