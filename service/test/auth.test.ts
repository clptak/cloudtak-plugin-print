import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.SigningSecret = 'test-secret';

const { default: auth, tokenFrom } = await import('../lib/auth.js');

test('a token signed with SigningSecret verifies and yields the CloudTAK claims', () => {
    const token = jwt.sign({ email: 'user@example.com', access: 'user' }, process.env.SigningSecret!);

    const decoded = auth(token);

    assert.equal(decoded.email, 'user@example.com');
    assert.equal(decoded.access, 'user');
});

// batch-error surfaces the underlying jsonwebtoken message ('invalid signature',
// 'jwt expired') rather than the label passed to Err. That is fine to expose and
// useful when debugging, but it means the status code is what to assert on.
const status = (fn: () => unknown): number => {
    try {
        fn();
    } catch (err) {
        return (err as { status?: number }).status ?? 0;
    }
    throw new Error('expected a throw');
};

test('a token signed with the wrong secret is rejected', () => {
    const token = jwt.sign({ email: 'user@example.com', access: 'user' }, 'not-the-secret');

    assert.equal(status(() => auth(token)), 401);
    assert.throws(() => auth(token), /invalid signature/);
});

test('an expired token is rejected', () => {
    const token = jwt.sign(
        { email: 'user@example.com', access: 'user' },
        process.env.SigningSecret!,
        { expiresIn: '-1s' },
    );

    assert.equal(status(() => auth(token)), 401);
});

test('a missing token is rejected rather than treated as anonymous', () => {
    assert.equal(status(() => auth(undefined)), 401);
    assert.throws(() => auth(undefined), /Authentication Required/);
});

test('tokens are accepted from the Authorization header or the query string', () => {
    assert.equal(tokenFrom({ authorization: 'Bearer abc123' }, {}), 'abc123');
    assert.equal(tokenFrom({ authorization: 'bearer abc123' }, {}), 'abc123');
    assert.equal(tokenFrom({}, { token: 'xyz789' }), 'xyz789');
    assert.equal(tokenFrom({}, {}), undefined);

    // Header wins when both are present.
    assert.equal(tokenFrom({ authorization: 'Bearer header' }, { token: 'query' }), 'header');
});
