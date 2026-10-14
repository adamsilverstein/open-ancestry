import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { SECURITY_HEADERS } from './security';

/*
 * The SPA shell (index.html) is served per request with a fresh nonce: in the
 * CSP's style-src and in <meta name="csp-nonce">, where the app hands it to
 * the dialog library's scroll lock (a runtime <style> element). Scripts stay
 * 'self' only; no 'unsafe-inline' anywhere.
 */

export function shellCsp(nonce: string): string {
  return `${SECURITY_HEADERS['content-security-policy']}; style-src 'self' 'nonce-${nonce}'`;
}

export function renderShell(indexHtml: string, nonce: string): string {
  const meta = `<meta name="csp-nonce" content="${nonce}">`;
  return /<\/head>/i.test(indexHtml)
    ? indexHtml.replace(/<\/head>/i, `${meta}</head>`)
    : indexHtml.replace(/^(<!doctype html>)?/i, `$1${meta}`);
}

export function sendShell(reply: FastifyReply, indexHtml: string) {
  const nonce = randomBytes(16).toString('base64');
  return reply
    .header('content-security-policy', shellCsp(nonce))
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(renderShell(indexHtml, nonce));
}
