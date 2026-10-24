import { getAddress } from 'viem';
import { addressesMatch, InvalidAddressError, normalizeAddress } from './addresses';

const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';

describe('normalizeAddress', () => {
    it('accepts a correct checksum and stores lowercase', () => {
        expect(normalizeAddress(WETH)).toBe(WETH.toLowerCase());
        expect(normalizeAddress(WETH.toLowerCase())).toBe(WETH.toLowerCase());
    });

    it('rejects a mixed-case address with a bad checksum', () => {
        const broken = '0x' + WETH.slice(2, 4).toLowerCase() + WETH.slice(4);
        expect(broken).not.toBe(getAddress(WETH));
        expect(() => normalizeAddress(broken)).toThrow(/Invalid address/);
    });

    it('rejects a value that is not an address', () => {
        expect(() => normalizeAddress('0xabc')).toThrow(/Invalid address/);
    });

    it('marks a rejected address as user input', () => {
        const error = (() => {
            try {
                normalizeAddress('0xabc');
            } catch (caught) {
                return caught;
            }
        })();

        expect(error).toBeInstanceOf(InvalidAddressError);
        expect((error as InvalidAddressError).extensions.code).toBe('BAD_USER_INPUT');
    });
});

describe('addressesMatch', () => {
    it('matches checksum and lowercase forms', () => {
        expect(addressesMatch(WETH, WETH.toLowerCase())).toBe(true);
    });
});
