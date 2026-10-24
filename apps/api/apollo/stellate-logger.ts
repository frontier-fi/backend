import type { ApolloServerPlugin } from '@apollo/server';
import { createStellateLoggerPlugin } from 'stellate/apollo-server';

/** Must match `name` in stellate.ts. */
export const STELLATE_SERVICE = 'frontier-api';

/**
 * Starts the upload and resolves at once. The plugin awaits its fetch before Apollo sends each
 * response, so a slow or unreachable Stellate would otherwise slow down every request.
 */
export function backgroundFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    return Promise.resolve(new Response(null, { status: 202 }));
}

/**
 * Sends request metrics and the schema to Stellate. The plugin skips requests that came through the
 * Stellate edge, which records those itself. Off on the SOR instance, whose requests are the API's
 * internal proxy calls, and outside production, so local runs do not reach the production service.
 */
export function stellateLoggerPlugin(settings: {
    NODE_ENV: string;
    SOR_INSTANCE: boolean;
    STELLATE_LOGGING_TOKEN?: string;
}): ApolloServerPlugin | undefined {
    if (settings.NODE_ENV !== 'production' || settings.SOR_INSTANCE || !settings.STELLATE_LOGGING_TOKEN) {
        return undefined;
    }

    return createStellateLoggerPlugin({
        serviceName: STELLATE_SERVICE,
        token: settings.STELLATE_LOGGING_TOKEN,
        // With Bun's types in scope, `typeof fetch` also requires Bun's `preconnect`.
        fetch: backgroundFetch as typeof fetch,
    });
}
