/**
 * Credential-free public latency probe for trusted control-plane UIs.
 *
 * The response contains no user or server data, so a wildcard origin is safe
 * here. These headers deliberately apply to this route only; authenticated
 * SillyTavern APIs retain the global same-origin policy.
 *
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 */
export default function publicPingMiddleware(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Cache-Control', 'no-store');
    response.status(204).end();
}
