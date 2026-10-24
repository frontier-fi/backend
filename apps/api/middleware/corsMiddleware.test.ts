import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { corsMiddleware } from './corsMiddleware';

describe('corsMiddleware', () => {
    let server: Server | undefined;

    afterEach(async () => {
        await new Promise((resolve) => server?.close(resolve));
        server = undefined;
    });

    async function start(route: express.RequestHandler): Promise<string> {
        const app = express();
        app.use(corsMiddleware);
        app.all('/graphql', route);
        server = await new Promise<Server>((resolve) => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
    }

    it('answers a preflight itself, allowing the Apollo client headers', async () => {
        const route = vi.fn<express.RequestHandler>((_req, res) => {
            res.sendStatus(400);
        });
        const url = await start(route);

        const response = await fetch(url, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://app.frontier.fi',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type,x-graphql-client-name,x-graphql-client-version',
            },
        });

        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('access-control-allow-methods')).toContain('POST');
        expect(response.headers.get('access-control-allow-headers')?.toLowerCase().split(',')).toEqual(
            expect.arrayContaining(['content-type', 'x-graphql-client-name', 'x-graphql-client-version']),
        );
        expect(response.headers.get('access-control-max-age')).toBe('600');
        expect(route).not.toHaveBeenCalled();
    });

    it('adds the headers to other requests and passes them on', async () => {
        const url = await start((_req, res) => {
            res.json({ data: { ok: true } });
        });

        const response = await fetch(url, {
            method: 'POST',
            headers: { Origin: 'https://app.frontier.fi', 'Content-Type': 'application/json' },
            body: '{}',
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(await response.json()).toEqual({ data: { ok: true } });
    });
});
