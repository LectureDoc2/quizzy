import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let blacklist = null;

function loadBlacklist() {
    if (blacklist !== null) return blacklist;

    try {
        const blacklistPath = path.join(__dirname, 'name-blacklist.json');
        const data = JSON.parse(fs.readFileSync(blacklistPath, 'utf8'));
        blacklist = new Set(data.blacklist.map(name => name.toLowerCase()));
    } catch (err) {
        console.error('Failed to load name blacklist:', err.message);
        blacklist = new Set();
    }
    return blacklist;
}

export const NAME_PATTERN = /^(([\p{L}][\p{L}'\- ]{0,48}[\p{L}])|([\p{Nd}]{6,16}))$/u; // a real name or a matriculation number
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 50;

/**
 * Check a participant's name.
 *
 * A refusal carries `code` and `params` next to the English `error`, so that
 * the join page can say it in the participant's language (see
 * web/locales/*.json, keys `error.<code>`).
 *
 * @returns {{valid: true, name: string}
 *   | {valid: false, error: string, code: string, params?: object}}
 */
export function validateName(name) {
    if (!name || typeof name !== 'string') {
        return { valid: false, code: 'name_required', error: 'Name is required' };
    }

    const trimmed = name.trim();

    if (trimmed.length < NAME_MIN_LENGTH) {
        return {
            valid: false,
            code: 'name_too_short',
            params: { min: NAME_MIN_LENGTH },
            error: `Name must be at least ${NAME_MIN_LENGTH} characters`
        };
    }

    if (trimmed.length > NAME_MAX_LENGTH) {
        return {
            valid: false,
            code: 'name_too_long',
            params: { max: NAME_MAX_LENGTH },
            error: `Name must be at most ${NAME_MAX_LENGTH} characters`
        };
    }

    if (!NAME_PATTERN.test(trimmed)) {
        return {
            valid: false,
            code: 'name_invalid_characters',
            error: 'Name must contain only letters, spaces, hyphens, and apostrophes'
        };
    }

    const blacklistSet = loadBlacklist();
    const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ').trim();

    if (blacklistSet.has(normalized)) {
        return { valid: false, code: 'name_not_allowed', error: 'This name is not allowed' };
    }

    return { valid: true, name: trimmed };
}

export function isBlacklisted(name) {
    if (!name || typeof name !== 'string') return false;

    const blacklistSet = loadBlacklist();
    const normalized = name.toLowerCase().trim().replace(/\s+/g, ' ');
    return blacklistSet.has(normalized);
}
