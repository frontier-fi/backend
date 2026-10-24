import { Chain } from '@prisma/client';
import { GraphQLError } from 'graphql';
import { isAddress, zeroAddress } from 'viem';
import config from '../../config';

/** Thrown for user input, so the API answers with BAD_USER_INPUT instead of an internal error. */
export class InvalidAddressError extends GraphQLError {
    constructor(address: string) {
        super(`Invalid address ${address}`, { extensions: { code: 'BAD_USER_INPUT' } });
        this.name = 'InvalidAddressError';
    }
}

/**
 * Identity for stored addresses is lowercase. EIP-55 is a checksum on the way in,
 * not a second spelling of the same contract.
 *
 * Accepts an all-lowercase address or a correct checksum and returns lowercase.
 * A mixed-case address with a bad checksum throws.
 */
export function normalizeAddress(address: string): string {
    // strict: mixed-case must be a valid EIP-55 checksum. All-lowercase is accepted.
    if (!isAddress(address)) {
        throw new InvalidAddressError(address);
    }
    return address.toLowerCase();
}

/** Case-insensitive equality. Does not validate the checksum. */
export function addressesMatch(address1: string, address2: string) {
    return address1.toLowerCase() === address2.toLowerCase();
}

export function replaceZeroAddressWithEth(address: string, chain: Chain) {
    if (addressesMatch(address, zeroAddress)) {
        return config[chain].eth.address;
    }

    return address;
}
