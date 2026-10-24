import { describe, expect, it } from 'vitest';
import config from '../../config';
import { globalWorkerJobs } from '../../config/worker-jobs';
import { buildSchedule, configuredSchedule, STARTUP_STAGGER_MS } from './schedule';

const networks = Object.values(config);
const [primary] = networks;
const primaryChainId = String(primary.chain.id);
const otherNetwork = { ...primary, chain: { ...primary.chain, id: 1 } };

describe('configuredSchedule', () => {
    const schedule = configuredSchedule();

    it('schedules every global job exactly once, on the first network', () => {
        for (const job of globalWorkerJobs) {
            const entries = schedule.filter((entry) => entry.name === job.name);
            expect(entries).toEqual([expect.objectContaining({ chainId: primaryChainId, interval: job.interval })]);
        }
    });

    it('schedules every chain job once per network', () => {
        for (const network of networks) {
            for (const job of network.workerJobs) {
                const entries = schedule.filter(
                    (entry) => entry.name === job.name && entry.chainId === String(network.chain.id),
                );
                expect(entries).toHaveLength(1);
            }
        }
    });

    it('never schedules the same job twice for one chain', () => {
        const ids = schedule.map((entry) => `${entry.name}-${entry.chainId}`);

        expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps the global list separate from every chain list', () => {
        const globalNames = new Set(globalWorkerJobs.map((job) => job.name));

        for (const network of networks) {
            expect(network.workerJobs.filter((job) => globalNames.has(job.name))).toEqual([]);
        }
    });

    it('gives every job a positive interval', () => {
        for (const entry of schedule) {
            expect(entry.interval).toBeGreaterThan(0);
        }
    });

    it('starts pool discovery first', () => {
        expect(schedule[0]).toMatchObject({ name: 'add-pools-v3', initialDelay: 0 });
    });
});

describe('buildSchedule', () => {
    it('keeps global jobs single and repeats chain jobs when another network is configured', () => {
        const schedule = buildSchedule([primary, otherNetwork], globalWorkerJobs);

        for (const job of globalWorkerJobs) {
            expect(schedule.filter((entry) => entry.name === job.name).map((entry) => entry.chainId)).toEqual([
                primaryChainId,
            ]);
        }
        for (const job of primary.workerJobs) {
            expect(schedule.filter((entry) => entry.name === job.name).map((entry) => entry.chainId)).toEqual([
                primaryChainId,
                '1',
            ]);
        }
    });

    it('staggers first runs without delaying a job past its own interval', () => {
        const schedule = buildSchedule(networks, globalWorkerJobs);

        expect(schedule[0].initialDelay).toBe(0);
        schedule.forEach((entry, index) => {
            expect(entry.initialDelay).toBe(Math.min(index * STARTUP_STAGGER_MS, entry.interval));
        });
    });

    it('uses the stagger it is given', () => {
        const schedule = buildSchedule([primary], [], 1_000);

        expect(schedule.slice(0, 3).map((entry) => entry.initialDelay)).toEqual([0, 1_000, 2_000]);
    });

    it('schedules nothing without a network', () => {
        expect(buildSchedule([], globalWorkerJobs)).toEqual([]);
    });
});
