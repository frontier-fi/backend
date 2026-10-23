import { Chain } from '@prisma/client';
import config from '../../../config';
import { addressesMatch } from '../../web3/addresses';
import { getToken } from './helpers';

export function isValidSwapRequest(tokenIn: string, tokenOut: string, swapAmount: string, chain: Chain): boolean {
    const swapAmountNumber = Number(swapAmount);
    if (Number.isNaN(swapAmountNumber) || swapAmountNumber <= 0) {
        return false;
    }

    const wethIsEth = addressesMatch(tokenIn, config[chain].eth.address) || addressesMatch(tokenOut, config[chain].eth.address);

    // Check if tokens are the same or if trying to swap between WETH/ETH
    if (
        addressesMatch(tokenIn, tokenOut) ||
        (wethIsEth && (addressesMatch(tokenIn, config[chain].weth.address) || addressesMatch(tokenOut, config[chain].weth.address)))
    ) {
        return false;
    }

    return true;
}

export async function validateTokens(tokenIn: string, tokenOut: string, chain: Chain): Promise<boolean> {
    try {
        await getToken(tokenIn, chain);
        await getToken(tokenOut, chain);
        return true;
    } catch (e) {
        console.log('Missing token for SOR request', `in: ${tokenIn}`, `out: ${tokenOut}`, chain);
        return false;
    }
}
