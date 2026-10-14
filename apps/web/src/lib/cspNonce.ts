import { setNonce } from 'get-nonce';

/**
 * The server's CSP only allows <style> elements carrying the per-response
 * nonce it puts in <meta name="csp-nonce">. The dialog library's scroll lock
 * injects such an element at runtime and reads the nonce from get-nonce.
 */
export function applyCspNonce(): void {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
  if (nonce) setNonce(nonce);
}
