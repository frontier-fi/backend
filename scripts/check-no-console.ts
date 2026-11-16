import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_DIRS = ['apps', 'modules', 'config', 'prisma'];
const SKIP_DIRS = new Set(['node_modules', 'generated', '__mocks__']);
const TEST_FILE_RE = /\.(test|spec|e2e)\.ts$/;
const CONSOLE_CALL_RE =
    /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|table|dir|time|timeEnd|timeLog|assert|count|group|groupEnd)\b/;

function stripCommentsPreservingNewlines(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

function collectTsFiles(dir: string, out: string[]): void {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) {
            continue;
        }
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectTsFiles(fullPath, out);
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !TEST_FILE_RE.test(entry.name)) {
            out.push(fullPath);
        }
    }
}

export function findConsoleViolations(rootDir: string = process.cwd()): string[] {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) {
        collectTsFiles(join(rootDir, dir), files);
    }

    const violations: string[] = [];
    for (const file of files.sort()) {
        const content = readFileSync(file, 'utf8');
        const cleaned = stripCommentsPreservingNewlines(content);
        const lines = cleaned.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(CONSOLE_CALL_RE);
            if (match) {
                violations.push(`${relative(rootDir, file)}:${i + 1}: disallowed console.${match[1]} (use logger)`);
            }
        }
    }

    return violations;
}

if (require.main === module) {
    const violations = findConsoleViolations();
    if (violations.length > 0) {
        process.stderr.write(`Found console.* calls in app code:\n${violations.join('\n')}\n`);
        process.exit(1);
    }
}
