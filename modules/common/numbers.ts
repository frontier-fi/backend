import { formatUnits } from 'viem';

/**
 * Converts wei to float
 *
 * @param value
 * @param decimals
 * @returns
 */
export const weiToFloat = (value: string | bigint, decimals: number): number => {
    // Guard against null or undefined
    if (value === null || value === undefined) {
        return 0;
    }

    // Guard agains float values
    if (typeof value === 'string' && value.includes('.')) {
        return parseFloat(value);
    }

    const wei = typeof value === 'string' ? BigInt(value) : value;
    const str = formatUnits(wei, decimals);

    return parseFloat(str);
};

/**
 * Formats float as a strings without scientific notation
 *
 * @param value
 * @param decimals
 * @returns
 */
export const floatToExactString = (num: number | string) => {
    if (typeof num === 'string') {
        num = Number(num);
    }
    if (isNaN(num)) {
        return '0';
    }
    const sign = num < 0 ? '-' : '';
    const str = Math.abs(num).toString();
    if (str.includes('e')) {
        const [base, exponent] = str.split('e');
        if (Number(exponent) < 0) {
            // For negative exponent, we need to add leading zeros after decimal point
            const absExp = Math.abs(parseInt(exponent, 10));
            const [intPart, decimalPart] = base.split('.');
            const actualInt = intPart === '0' ? '' : intPart;
            const actualDecimal = decimalPart || '';

            return `${sign}0.${'0'.repeat(absExp - 1)}${actualInt}${actualDecimal}`;
        } else {
            // For positive exponent, shift decimal point right by exp places
            const exp = parseInt(exponent, 10);
            const [intPart, decimalPart = ''] = base.split('.');
            if (decimalPart.length >= exp) {
                const newDecimal = decimalPart.slice(exp);
                return `${sign}${intPart}${decimalPart.slice(0, exp)}${newDecimal ? '.' + newDecimal : ''}`;
            }
            return `${sign}${intPart}${decimalPart}${'0'.repeat(exp - decimalPart.length)}`;
        }
    }
    return `${sign}${str}`;
};
