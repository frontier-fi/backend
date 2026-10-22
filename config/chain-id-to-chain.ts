import { Chain } from '@prisma/client';
import config from './index';

const networks = Object.values(config);

export const chainIdToChain: { [id: string]: Chain } = Object.fromEntries(
    networks.map((network) => [String(network.chain.id), network.chain.prismaId]),
);

export const chainToChainId: { [chain: string]: string } = Object.fromEntries(
    networks.map((network) => [network.chain.prismaId, String(network.chain.id)]),
);
