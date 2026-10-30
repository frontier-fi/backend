import { describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';
import { eventsRepository } from '../repositories/events';
import { EventsQueryController } from './event-query-controller';
import { EventController } from './event-controller';
import * as syncSwapsModule from '../actions/pool/v3/sync-swaps';
import * as updateVolumeAndFeesModule from '../actions/pool/update-volume-and-fees';

describe('EventsQueryController', () => {
    it('returns an empty list without querying the database when chainIn is missing or empty', async () => {
        const getEventsSpy = vi.spyOn(eventsRepository, 'getEvents').mockResolvedValue([]);

        expect(await EventsQueryController().getEvents({ where: {} })).toEqual([]);
        expect(await EventsQueryController().getEvents({ where: { chainIn: [] } })).toEqual([]);
        expect(getEventsSpy).not.toHaveBeenCalled();

        getEventsSpy.mockRestore();
    });

    it('forwards multi-element typeIn and poolIdIn along with userAddress to eventsRepository.getEvents', async () => {
        const getEventsSpy = vi.spyOn(eventsRepository, 'getEvents').mockResolvedValue([]);

        await EventsQueryController().getEvents({
            where: {
                chainIn: ['SEPOLIA'],
                typeIn: ['ADD', 'REMOVE'],
                poolIdIn: ['0xpool1', '0xpool2'],
                userAddress: '0xAbCdEf0000000000000000000000000000000001',
            },
        });

        expect(getEventsSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                chain: 'SEPOLIA',
                eventTypeIn: ['JOIN', 'EXIT'],
                poolIdIn: ['0xpool1', '0xpool2'],
                userAddress: '0xAbCdEf0000000000000000000000000000000001',
            }),
        );

        getEventsSpy.mockRestore();
    });

    it('skips updateVolumeAndFees in EventController.syncSwapsUpdateVolumeAndFeesV3 when syncSwaps returns no pools', async () => {
        const syncSwapsSpy = vi.spyOn(syncSwapsModule, 'syncSwaps').mockResolvedValue([]);
        const updateVolSpy = vi.spyOn(updateVolumeAndFeesModule, 'updateVolumeAndFees').mockResolvedValue(undefined);

        const result = await EventController().syncSwapsUpdateVolumeAndFeesV3(Chain.SEPOLIA);

        expect(result).toEqual([]);
        expect(syncSwapsSpy).toHaveBeenCalledTimes(1);
        expect(updateVolSpy).not.toHaveBeenCalled();

        syncSwapsSpy.mockRestore();
        updateVolSpy.mockRestore();
    });
});
