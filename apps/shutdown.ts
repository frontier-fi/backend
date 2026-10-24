export interface Stoppable {
    stop(): Promise<void> | void;
}

// App Platform sends SIGKILL 120 s after SIGTERM, unless the component sets termination.grace_period_seconds.
export const SHUTDOWN_DEADLINE_MS = 110_000;

interface ShutdownOptions {
    /** Runs once every part has stopped or failed to. */
    cleanup: () => Promise<void>;
    exit: (code: number) => void;
    deadlineMs?: number;
}

/**
 * Returns a signal handler that stops the parts one at a time, in their order at the time of the
 * signal, then cleans up and exits. The exit code is 1 when a step fails or the deadline passes.
 */
export function createShutdown(
    parts: readonly Stoppable[],
    { cleanup, exit, deadlineMs = SHUTDOWN_DEADLINE_MS }: ShutdownOptions,
): (signal: string) => Promise<void> {
    let started = false;

    return async (signal) => {
        if (started) {
            return;
        }
        started = true;
        console.log(`${signal} received, shutting down`);

        const deadline = setTimeout(() => {
            console.error(`Shutdown did not finish within ${deadlineMs / 1000}s`);
            exit(1);
        }, deadlineMs);

        let code = 0;
        for (const part of parts) {
            try {
                await part.stop();
            } catch (error) {
                console.error('Shutdown step failed:', error);
                code = 1;
            }
        }
        try {
            await cleanup();
        } catch (error) {
            console.error('Shutdown cleanup failed:', error);
            code = 1;
        }

        clearTimeout(deadline);
        exit(code);
    };
}
