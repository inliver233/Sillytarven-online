/**
 * Browser side of passkeys: turns the JSON options from /api/passkeys into
 * WebAuthn calls and the resulting credential back into JSON.
 */

function fromBase64Url(value) {
    const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function toBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @returns {boolean} Whether this browser can use passkeys on this page */
export function isPasskeySupported() {
    return Boolean(window.isSecureContext && window.PublicKeyCredential
        && navigator.credentials && typeof navigator.credentials.create === 'function'
        && typeof navigator.credentials.get === 'function');
}

/**
 * @param {string} rpId Domain the passkeys belong to
 * @returns {boolean} Whether this page's host can use passkeys of that domain
 */
export function isHostCoveredBy(rpId) {
    const host = location.hostname;
    return Boolean(rpId) && (host === rpId || host.endsWith(`.${rpId}`));
}

/**
 * Creates a passkey.
 * @param {object} options PublicKeyCredentialCreationOptionsJSON
 * @returns {Promise<object>} RegistrationResponseJSON
 */
export async function createPasskey(options) {
    const publicKey = {
        ...options,
        challenge: fromBase64Url(options.challenge),
        user: { ...options.user, id: fromBase64Url(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map(item => ({ ...item, id: fromBase64Url(item.id) })),
    };
    const credential = /** @type {PublicKeyCredential} */ (await navigator.credentials.create({ publicKey }));
    const response = /** @type {AuthenticatorAttestationResponse} */ (credential.response);
    return {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            attestationObject: toBase64Url(response.attestationObject),
            transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
        },
        authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
        clientExtensionResults: credential.getClientExtensionResults(),
    };
}

/**
 * Signs in with a passkey of the user's choice.
 * @param {object} options PublicKeyCredentialRequestOptionsJSON
 * @returns {Promise<object>} AuthenticationResponseJSON
 */
export async function getPasskey(options) {
    const publicKey = {
        ...options,
        challenge: fromBase64Url(options.challenge),
        allowCredentials: (options.allowCredentials || []).map(item => ({ ...item, id: fromBase64Url(item.id) })),
    };
    const credential = /** @type {PublicKeyCredential} */ (await navigator.credentials.get({ publicKey }));
    const response = /** @type {AuthenticatorAssertionResponse} */ (credential.response);
    return {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            authenticatorData: toBase64Url(response.authenticatorData),
            signature: toBase64Url(response.signature),
            userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
        },
        authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
        clientExtensionResults: credential.getClientExtensionResults(),
    };
}

/**
 * Tells the passkey manager that a passkey no longer works here, so it stops
 * offering it (supported by recent Chrome; a no-op elsewhere).
 * @param {string} rpId Domain the passkeys belong to
 * @param {string} credentialId Credential ID
 */
export function forgetPasskey(rpId, credentialId) {
    try {
        // @ts-ignore - newer API
        void window.PublicKeyCredential?.signalUnknownCredential?.({ rpId, credentialId })?.catch?.(() => undefined);
    } catch {
        // Optional.
    }
}

/**
 * A short, user-facing explanation for a WebAuthn error, or null when the user
 * simply cancelled.
 * @param {unknown} error Error from createPasskey/getPasskey
 * @param {'create'|'get'} action What was attempted
 * @returns {string|null}
 */
export function describePasskeyError(error, action) {
    const name = error instanceof Error || error instanceof DOMException ? error.name : '';
    switch (name) {
        case 'NotAllowedError':
        case 'AbortError':
            return null;
        case 'InvalidStateError':
            return action === 'create' ? '这台设备（或这个密码管理器）里已经有本账号的通行密钥了，可以直接用它登录。' : '通行密钥暂时不可用，请再试一次。';
        case 'SecurityError':
            return '当前网址不能使用通行密钥，请从本站的正式地址打开。';
        case 'NotSupportedError':
            return '这台设备不支持通行密钥。';
        default:
            return action === 'create' ? '添加通行密钥失败，请再试一次。' : '通行密钥登录失败，请再试一次。';
    }
}

/**
 * A name for a new passkey from the device it is created on, e.g. "iPhone".
 * The server prefers the passkey manager's own name when it knows it.
 * @returns {string}
 */
export function guessDeviceName() {
    const ua = navigator.userAgent;
    const device = /iPhone/.test(ua) ? 'iPhone'
        : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
            : /Android/.test(ua) ? 'Android 手机'
                : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
                    : /Windows/.test(ua) ? 'Windows 电脑'
                        : /CrOS/.test(ua) ? 'Chromebook'
                            : /Linux/.test(ua) ? 'Linux 电脑' : '我的设备';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return browser ? `${device} · ${browser}` : device;
}
