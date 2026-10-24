import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN_SECRET_HEADER, requireOriginSecret } from './originSecret';

describe('requireOriginSecret', () => {
    let server: Server | undefined;

    afterEach(async () => {
        await new Promise((resolve) => server?.close(resolve));
        server = undefined;
    });

    async function start(secret: string | undefined): Promise<string> {
        const app = express();
        app.get('/health', (_req, res) => res.sendStatus(200));
        app.use(requireOriginSecret(secret));
        app.post('/graphql', (_req, res) => res.json({ data: { ok: true } }));
        server = await new Promise<Server>((resolve) => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    const post = (baseUrl: string, headers: Record<string, string> = {}) =>
        fetch(`${baseUrl}/graphql`, { method: 'POST', headers });

    it('lets every request through when no secret is configured', async () => {
        const baseUrl = await start(undefined);

        expect((await post(baseUrl)).status).toBe(200);
    });

    it('rejects a request without the secret or with the wrong one', async () => {
        const baseUrl = await start('origin-secret');

        const missing = await post(baseUrl);
        expect(missing.status).toBe(403);
        expect(await missing.json()).toEqual({ errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }] });
        expect((await post(baseUrl, { [ORIGIN_SECRET_HEADER]: 'origin-secreT' })).status).toBe(403);
        expect((await post(baseUrl, { [ORIGIN_SECRET_HEADER]: 'origin' })).status).toBe(403);
    });

    it('lets a request with the secret through', async () => {
        const baseUrl = await start('origin-secret');

        expect((await post(baseUrl, { [ORIGIN_SECRET_HEADER]: 'origin-secret' })).status).toBe(200);
    });

    it('does not check routes registered before it', async () => {
        const baseUrl = await start('origin-secret');

        expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    });
});
