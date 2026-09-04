import jwt from 'jsonwebtoken';
import Err from '@openaddresses/batch-error';
import config from './config.js';

/**
 * CloudTAK's token shape. Verified against CloudTAK tasks/pmtiles/lib/auth.ts —
 * HS256 signed with the shared SigningSecret. Keep this in sync with that file.
 */
export type JWTToken = {
    access: string;
    email: string;
    /** Optional file-scoped grant: '{username}/{file}' the token may access. */
    file?: string;
    iat: number;
};

export default function auth(token?: string): JWTToken {
    if (!token) throw new Err(401, null, 'Authentication Required');

    try {
        return jwt.verify(token, config().signingSecret) as JWTToken;
    } catch (err) {
        throw new Err(401, err instanceof Error ? err : new Error(String(err)), 'Invalid Token');
    }
}

/**
 * Pull a token from either the Authorization header or a `token` query param.
 * CloudTAK's client uses both depending on the call site.
 */
export function tokenFrom(headers: Record<string, unknown>, query: Record<string, unknown>): string | undefined {
    const header = headers['authorization'];
    if (typeof header === 'string') {
        const match = header.match(/^Bearer\s+(.+)$/i);
        if (match) return match[1];
    }

    if (typeof query.token === 'string') return query.token;

    return undefined;
}
