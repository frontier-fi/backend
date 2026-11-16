import { env } from '../../apps/env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown> & { err?: unknown };

const MAX_LOG_MESSAGE_CHARS = 300;
const MAX_LOG_ERROR_CHARS = 500;
const MAX_LOG_STACK_CHARS = 700;
export const MAX_LOG_LINE_BYTES = 1_600;

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

function isLogLevel(value: string): value is LogLevel {
    return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function configuredMinLevel(): LogLevel {
    const rawLevel = (env.LOG_LEVEL ?? process.env.LOG_LEVEL ?? '').trim().toLowerCase();
    if (isLogLevel(rawLevel)) {
        return rawLevel;
    }
    const rawDebug = (env.DEBUG ?? process.env.DEBUG ?? '').trim().toLowerCase();
    if (rawDebug !== '' && rawDebug !== '0' && rawDebug !== 'false') {
        return 'debug';
    }
    return 'info';
}

function secretValues(): string[] {
    return [env.DRPC_API_KEY, env.COINGECKO_API_KEY, env.MERKL_API_KEY].filter(
        (value): value is string => typeof value === 'string' && value.length >= 4,
    );
}

/** Replaces configured API secrets anywhere in a string before it is logged. */
export function redactSecrets(text: string): string {
    let result = text;
    for (const secret of secretValues()) {
        if (result.includes(secret)) {
            result = result.split(secret).join('***');
        }
    }
    return result;
}

/** Strips the repeated `Error: <message>` header so long error messages cannot crowd out stack frames. */
export function stackFrames(error: Error): string | undefined {
    if (!error.stack) {
        return undefined;
    }
    let rest = error.stack;
    if (error.message && rest.startsWith(`${error.name}: ${error.message}`)) {
        rest = rest.slice(error.name.length + 2 + error.message.length);
    } else if (error.message && rest.startsWith(`Error: ${error.message}`)) {
        rest = rest.slice('Error: '.length + error.message.length);
    } else if (rest === error.name || rest.startsWith(`${error.name}\n`) || rest.startsWith(`${error.name}\r\n`)) {
        rest = rest.slice(error.name.length);
    } else {
        const frameStart = rest.indexOf('\n    at ');
        if (frameStart !== -1) {
            rest = rest.slice(frameStart + 1);
        }
    }
    rest = rest.replace(/^\r?\n/, '');
    return rest.trim() ? rest : undefined;
}

function capText(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }
    let end = maxChars;
    if (end > 0) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
            end -= 1;
        }
    }
    return `${text.slice(0, end)}…`;
}

function highestFittingLength(maxChars: number, fits: (len: number) => boolean): number {
    let low = 0;
    let high = maxChars;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(mid)) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
}

function jsonReplacer(_key: string, value: unknown): unknown {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'string') {
        return redactSecrets(value);
    }
    return value;
}

function safeJsonStringify(payload: Record<string, unknown>): string {
    try {
        return JSON.stringify(payload, jsonReplacer);
    } catch {
        const fallback: Record<string, unknown> = {
            level: payload.level,
            message: payload.message,
            unserializableFields: true,
        };
        if (payload.error !== undefined) {
            fallback.error = payload.error;
        }
        if (payload.stack !== undefined) {
            fallback.stack = payload.stack;
        }
        return JSON.stringify(fallback, jsonReplacer);
    }
}

function extractErrorDetails(err: unknown, extraFields: Record<string, unknown>): { error?: string; stack?: string } {
    if (err !== undefined) {
        if (err instanceof Error) {
            const frames = stackFrames(err);
            return {
                error: redactSecrets(err.message || err.name || 'Error'),
                stack: frames ? redactSecrets(frames) : undefined,
            };
        }
        if (typeof err === 'string') {
            return { error: redactSecrets(err) };
        }
        try {
            const serialized = JSON.stringify(err, jsonReplacer);
            return { error: redactSecrets(serialized ?? String(err)) };
        } catch {
            return { error: redactSecrets(String(err)) };
        }
    }

    const extracted: { error?: string; stack?: string } = {};
    if (typeof extraFields.error === 'string') {
        extracted.error = redactSecrets(extraFields.error);
        delete extraFields.error;
    }
    if (typeof extraFields.stack === 'string') {
        extracted.stack = redactSecrets(extraFields.stack);
        delete extraFields.stack;
    }
    return extracted;
}

export function formatLogLine(level: LogLevel, message: string, fields?: LogFields): string {
    const { err, level: _ignoredLevel, message: _ignoredMessage, ...extraFields } = fields ?? {};
    const { error: rawError, stack: rawStack } = extractErrorDetails(err, extraFields);
    const safeMessage = capText(redactSecrets(message), MAX_LOG_MESSAGE_CHARS);

    const serialize = (fieldsObj: Record<string, unknown>, error?: string, stack?: string) =>
        safeJsonStringify({
            level,
            message: safeMessage,
            ...fieldsObj,
            ...(error !== undefined ? { error } : {}),
            ...(stack !== undefined ? { stack } : {}),
        });

    let cappedError = rawError !== undefined ? capText(rawError, MAX_LOG_ERROR_CHARS) : undefined;
    let cappedStack = rawStack !== undefined ? capText(rawStack, MAX_LOG_STACK_CHARS) : undefined;
    let line = serialize(extraFields, cappedError, cappedStack);

    if (Buffer.byteLength(line, 'utf8') <= MAX_LOG_LINE_BYTES) {
        return line;
    }

    if (
        rawStack !== undefined &&
        Buffer.byteLength(serialize(extraFields, cappedError, undefined), 'utf8') <= MAX_LOG_LINE_BYTES
    ) {
        const len = highestFittingLength(
            Math.max(0, Math.min(rawStack.length, MAX_LOG_STACK_CHARS) - 1),
            (candidate) =>
                Buffer.byteLength(serialize(extraFields, cappedError, capText(rawStack, candidate)), 'utf8') <=
                MAX_LOG_LINE_BYTES,
        );
        cappedStack = len > 0 ? capText(rawStack, len) : undefined;
        return serialize(extraFields, cappedError, cappedStack);
    }

    cappedStack = undefined;
    if (
        rawError !== undefined &&
        Buffer.byteLength(serialize(extraFields, undefined, undefined), 'utf8') <= MAX_LOG_LINE_BYTES
    ) {
        const len = highestFittingLength(
            Math.max(0, Math.min(rawError.length, MAX_LOG_ERROR_CHARS) - 1),
            (candidate) =>
                Buffer.byteLength(serialize(extraFields, capText(rawError, candidate), undefined), 'utf8') <=
                MAX_LOG_LINE_BYTES,
        );
        cappedError = capText(rawError, len);
        return serialize(extraFields, cappedError, undefined);
    }

    const minimalFields: Record<string, unknown> = { truncatedFields: true };
    if (rawError === undefined) {
        return serialize(minimalFields, undefined, undefined);
    }
    const baseBytes = Buffer.byteLength(serialize(minimalFields, undefined, undefined), 'utf8');
    const errorCap =
        baseBytes <= MAX_LOG_LINE_BYTES
            ? highestFittingLength(
                  Math.min(rawError.length, MAX_LOG_ERROR_CHARS),
                  (candidate) =>
                      Buffer.byteLength(serialize(minimalFields, capText(rawError, candidate), undefined), 'utf8') <=
                      MAX_LOG_LINE_BYTES,
              )
            : 0;
    return serialize(minimalFields, errorCap > 0 ? capText(rawError, errorCap) : '…', undefined);
}

function writeLog(level: LogLevel, message: string, fields?: LogFields): void {
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[configuredMinLevel()]) {
        return;
    }
    const line = `${formatLogLine(level, message, fields)}\n`;
    if (level === 'warn' || level === 'error') {
        process.stderr.write(line);
    } else {
        process.stdout.write(line);
    }
}

export const logger = {
    debug(message: string, fields?: LogFields): void {
        writeLog('debug', message, fields);
    },
    info(message: string, fields?: LogFields): void {
        writeLog('info', message, fields);
    },
    warn(message: string, fields?: LogFields): void {
        writeLog('warn', message, fields);
    },
    error(message: string, fields?: LogFields): void {
        writeLog('error', message, fields);
    },
};
