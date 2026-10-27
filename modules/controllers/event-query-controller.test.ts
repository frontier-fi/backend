import { describe, expect, it, vi } from 'vitest';
import { eventsRepository } from '../repositories/events';
import { EventsQueryController } from './event-query-controller';

describe('EventsQueryController', () => {
    it('returns an empty list without querying the database when chainIn is missing or empty', async () => {
        const getEventsSpy = vi.spyOn(eventsRepository, 'getEvents').mockResolvedValue([]);

        expect(await EventsQueryController().getEvents({ where: {} })).toEqual([]);
        expect(await EventsQueryController().getEvents({ where: { chainIn: [] } })).toEqual([]);
        expect(getEventsSpy).not.toHaveBeenCalled();

        getEventsSpy.mockRestore();
    });
});
