// test/browser/serve.mjs
//
// A minimal static file server for the browser demo lane. ES modules cannot be
// imported from a file:// origin (CORS blocks it: origin 'null'), so the demo
// gate serves the package root over HTTP with correct JS MIME types -- exactly
// what `npx serve .` does for a human. Nothing here is lite-inp specific; it is
// a read-only static server rooted at a directory, path-traversal guarded.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, normalize, extname, sep } from 'node:path';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};

export function startStaticServer(rootDir) {
    const root = resolve(rootDir);
    const server = createServer(async function (req, res) {
        try {
            const url = new URL(req.url, 'http://localhost');
            const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([.][.][/\\])+/, '');
            const full = resolve(root, '.' + sep + rel);
            // Fail closed on any traversal outside the served root.
            if (full !== root && !full.startsWith(root + sep)) {
                res.writeHead(403); res.end('forbidden'); return;
            }
            const body = await readFile(full);
            res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
            res.end(body);
        } catch (e) {
            res.writeHead(404); res.end('not found');
        }
    });
    return new Promise(function (r) {
        server.listen(0, '127.0.0.1', function () {
            const port = server.address().port;
            r({
                url: 'http://127.0.0.1:' + port,
                close: function () { return new Promise(function (rr) { server.close(rr); }); }
            });
        });
    });
}
