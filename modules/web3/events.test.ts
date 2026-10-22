import { getEvents } from './events';
import { vi, MockedFunction } from 'vitest';

// Mock `fetch` globally
global.fetch = vi.fn() as unknown as typeof fetch;

describe('getEvents', () => {
    beforeEach(() => {
        // Clear all instances and calls to constructor and all methods
        (global.fetch as MockedFunction<typeof fetch>).mockClear();
    });

    it('fetches successfully', async () => {
        (global.fetch as MockedFunction<typeof fetch>).mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify({ result: [] }))),
        );

        const result = await getEvents(0, 100, ['0x123'], ['0x456'], 'http://localhost', 50);
        expect(result).toEqual([]);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('handles fetch error', async () => {
        (global.fetch as MockedFunction<typeof fetch>).mockImplementationOnce(() => Promise.reject('Fetch error'));

        try {
            await getEvents(0, 100, ['0x123'], ['0x456'], 'http://localhost', 50);
        } catch (error) {
            expect(error).toEqual('Fetch error');
        }
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('splits address lists larger than maxAddresses into separate requests', async () => {
        const addresses = new Array(501).fill('0x1');
        const log = { address: 'address' };

        (global.fetch as MockedFunction<typeof fetch>).mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify({ result: [log] }))),
        );

        const result = await getEvents(0, 1, addresses, ['0xtopic'], 'http://localhost', 10, undefined, 500);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(2);
    });
});
