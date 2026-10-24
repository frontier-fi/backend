import { execFile } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { DATABASE_NAME, DATABASE_URL, repoRoot } from './config';

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { cwd: repoRoot, env, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${command} ${args.join(' ')} failed\n${stderr || stdout}\n${error.message}`));
                return;
            }
            resolve(stdout);
        });
    });
}

function psql(database: string, sql: string): Promise<string> {
    return run('docker', [
        'exec',
        'frontier-backend',
        'psql',
        '-U',
        'backend',
        '-d',
        database,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        sql,
    ]);
}

export async function assertPostgres(): Promise<void> {
    try {
        await run('docker', ['exec', 'frontier-backend', 'pg_isready', '-U', 'backend']);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Postgres is not accepting connections. Start it with docker compose up -d.\n${message}`);
    }
}

export async function recreateDatabase(): Promise<void> {
    await assertPostgres();
    await psql(
        'postgres',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid();`,
    );
    await psql('postgres', `DROP DATABASE IF EXISTS ${DATABASE_NAME}`);
    await psql('postgres', `CREATE DATABASE ${DATABASE_NAME}`);
}

export async function migrate(): Promise<void> {
    await run('bunx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema'], {
        ...process.env,
        DATABASE_URL,
    });
    await psql(DATABASE_NAME, 'SELECT COUNT(*) FROM "PrismaPool"');
}

export async function dropDatabase(): Promise<void> {
    try {
        await psql(
            'postgres',
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid();`,
        );
        await psql('postgres', `DROP DATABASE IF EXISTS ${DATABASE_NAME}`);
    } catch {
        // The container may already be gone. Leaving the database behind is the failure to report.
    }
}

export function createPrisma(): PrismaClient {
    return new PrismaClient({
        datasources: { db: { url: DATABASE_URL } },
    });
}
