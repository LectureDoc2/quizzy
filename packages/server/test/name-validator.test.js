import { test } from 'node:test';
import assert from 'node:assert';
import { validateName, isBlacklisted, NAME_PATTERN, NAME_MIN_LENGTH, NAME_MAX_LENGTH } from '../src/name-validator.js';

test('validateName accepts valid names', () => {
    const validNames = [
        'John',
        'Mary Smith',
        'Jean-Pierre',
        'O\'Connor',
        'María',
        'François',
        'Hans-Peter',
        'Anna Maria',
        'Jo', // minimum length
        'ab' // minimum length
    ];
    
    for (const name of validNames) {
        const result = validateName(name);
        assert.strictEqual(result.valid, true, `Expected "${name}" to be valid`);
        assert.strictEqual(result.name, name.trim());
    }
});

test('validateName rejects empty or null names', () => {
    const invalidNames = ['', null, undefined, '   '];
    
    for (const name of invalidNames) {
        const result = validateName(name);
        assert.strictEqual(result.valid, false);
        assert.ok(result.error);
    }
});

test('validateName rejects names that are too short', () => {
    const result = validateName('a');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('at least'));
});

test('validateName rejects names that are too long', () => {
    const longName = 'a'.repeat(NAME_MAX_LENGTH + 1);
    const result = validateName(longName);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('at most'));
});

test('validateName rejects names with invalid characters', () => {
    const invalidNames = [
        'John123',
        'Mary@Smith',
        'John!',
        'Test#Name',
        'Name$',
        'Name%',
        'Name^',
        'Name&',
        'Name*',
        'Name(',
        'Name)',
        'Name=',
        'Name+',
        'Name[',
        'Name]',
        'Name{',
        'Name}',
        'Name|',
        'Name\\',
        'Name/',
        'Name<',
        'Name>',
        'Name,',
        'Name.',
        'Name;',
        'Name:',
        'Name?',
        'Name~',
        'Name`',
    ];
    
    for (const name of invalidNames) {
        const result = validateName(name);
        assert.strictEqual(result.valid, false, `Expected "${name}" to be invalid`);
        assert.ok(result.error.includes('only letters') || result.error.includes('at least') || result.error.includes('at most'));
    }
});

test('validateName trims leading/trailing spaces', () => {
    const validNames = [
        ' John',
        'John ',
        '  John  ',
    ];
    
    for (const name of validNames) {
        const result = validateName(name);
        assert.strictEqual(result.valid, true, `Expected "${name}" to be valid after trimming`);
        assert.strictEqual(result.name, 'John');
    }
});

test('validateName rejects names starting or ending with hyphens/apostrophes', () => {
    const invalidNames = [
        '-John',
        'John-',
        "'John",
        "John'",
        '-John-',
        "'John'",
    ];
    
    for (const name of invalidNames) {
        const result = validateName(name);
        assert.strictEqual(result.valid, false, `Expected "${name}" to be invalid`);
    }
});

test('validateName rejects blacklisted names', () => {
    const blacklistedNames = [
        'adolf hitler',
        'Adolf Hitler',
        'ADOLF HITLER',
        'Adolf  Hitler',
        'Heinrich Himmler',
        'Joseph Goebbels',
        'Hermann Goering',
        'Benito Mussolini',
        'Hideki Tojo',
        'Pol Pot',
        'Slobodan Milosevic',
        'Radovan Karadzic',
        'Ratko Mladic',
        'Vladimir Putin',
        'Sergei Shoigu',
    ];
    
    for (const name of blacklistedNames) {
        const result = validateName(name);
        assert.strictEqual(result.valid, false, `Expected "${name}" to be rejected as blacklisted`);
        assert.ok(result.error.includes('not allowed') || result.error.includes('not allowed'), `Error for "${name}" should mention not allowed: ${result.error}`);
    }
});

test('isBlacklisted detects blacklisted names', () => {
    assert.strictEqual(isBlacklisted('adolf hitler'), true);
    assert.strictEqual(isBlacklisted('Adolf Hitler'), true);
    assert.strictEqual(isBlacklisted('ADOLF HITLER'), true);
    assert.strictEqual(isBlacklisted('John Smith'), false);
    assert.strictEqual(isBlacklisted(''), false);
    assert.strictEqual(isBlacklisted(null), false);
});

test('validateName trims whitespace', () => {
    const result = validateName('  John Doe  ');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.name, 'John Doe');
});

test('NAME_PATTERN allows Unicode letters', () => {
    const unicodeNames = [
        'José',
        'François',
        'Björn',
        'Müller',
        'Ñoño',
        'Роман',
        '日本',
        '中村',
    ];
    
    for (const name of unicodeNames) {
        assert.ok(NAME_PATTERN.test(name), `Expected "${name}" to match pattern`);
    }
});

test('NAME_PATTERN rejects names with numbers', () => {
    assert.ok(!NAME_PATTERN.test('John123'));
    assert.ok(!NAME_PATTERN.test('123'));
    assert.ok(!NAME_PATTERN.test('John2'));
});

test('NAME_MIN_LENGTH is 2', () => {
    assert.strictEqual(NAME_MIN_LENGTH, 2);
});

test('NAME_MAX_LENGTH is 50', () => {
    assert.strictEqual(NAME_MAX_LENGTH, 50);
});
