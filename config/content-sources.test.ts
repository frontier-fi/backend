import { describe, expect, it } from 'vitest';
import { contentSources } from './content-sources';

describe('contentSources', () => {
    it('reads every source from a frontier-fi fork', () => {
        const notForked = Object.entries(contentSources)
            .filter(([, url]) => !url.startsWith('https://raw.githubusercontent.com/frontier-fi/'))
            .map(([name]) => name);

        expect(notForked).toEqual([]);
    });
});
