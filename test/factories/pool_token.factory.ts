import { Factory } from 'fishery';

type FactoryPoolToken = {
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    address: string;
    balance: string;
    weight: string;
    priceRate: string;
    index: number;
    token: Record<string, never>;
};

export const poolTokenFactory = Factory.define<FactoryPoolToken>(() => ({
    id: 'token1',
    symbol: 'T1',
    name: 'Token 1',
    decimals: 18,
    address: 'token1',
    balance: '100',
    weight: '0.5',
    priceRate: '1',
    index: 0,
    token: {
        // token properties...
    },
}));
