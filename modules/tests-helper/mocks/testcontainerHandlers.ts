import { http, passthrough } from 'msw';

export const testcontainerHandlers = [
    http.get('http://localhost/containers/*', () => passthrough()),
    http.get('http://localhost/images/*', () => passthrough()),
    http.post('http://localhost/containers/*', () => passthrough()),
    http.delete('http://localhost/containers/*', () => passthrough()),
];
