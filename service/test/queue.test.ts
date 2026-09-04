import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../lib/queue.js';

const png = (): { body: Buffer; contentType: string } => ({ body: Buffer.from('x'), contentType: 'image/png' });

const settled = async (queue: Queue, id: string, owner: string) => {
    for (let i = 0; i < 200; i++) {
        const job = queue.get(id, owner);
        if (job && (job.status === 'complete' || job.status === 'failed')) return job;
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
    }
    throw new Error('job never settled');
};

test('a submitted job runs and completes with its artifact', async () => {
    const queue = new Queue(1, 60000);

    const submitted = queue.submit('user@example.com', async (ctx) => {
        ctx.progress(0.5, 'halfway');
        return png();
    });

    const job = await settled(queue, submitted.job, 'user@example.com');

    assert.equal(job.status, 'complete');
    assert.equal(job.progress, 1);
    assert.equal(job.artifact?.contentType, 'image/png');
});

test('a throwing worker fails the job without taking down the queue', async () => {
    const queue = new Queue(1, 60000);

    const bad = queue.submit('user@example.com', async () => {
        throw new Error('swiftshader exploded');
    });

    const failed = await settled(queue, bad.job, 'user@example.com');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'swiftshader exploded');

    const good = queue.submit('user@example.com', async () => png());
    const ok = await settled(queue, good.job, 'user@example.com');
    assert.equal(ok.status, 'complete');
});

test('concurrency is respected', async () => {
    const queue = new Queue(1, 60000);

    let peak = 0;
    let inFlight = 0;

    const worker = async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
        inFlight--;
        return png();
    };

    const ids = [0, 1, 2].map(() => queue.submit('user@example.com', worker).job);
    for (const id of ids) await settled(queue, id, 'user@example.com');

    assert.equal(peak, 1);
});

test('a job is not readable by another identity', async () => {
    const queue = new Queue(1, 60000);

    const submitted = queue.submit('owner@example.com', async () => png());
    await settled(queue, submitted.job, 'owner@example.com');

    assert.equal(queue.get(submitted.job, 'someone-else@example.com'), undefined);
    assert.ok(queue.get(submitted.job, 'owner@example.com'));
});

test('finished jobs are swept once past their TTL', async () => {
    const queue = new Queue(1, 0);

    const first = queue.submit('user@example.com', async () => png());
    await settled(queue, first.job, 'user@example.com');

    // The sweep runs when the next job finishes.
    const second = queue.submit('user@example.com', async () => png());
    await settled(queue, second.job, 'user@example.com');

    assert.equal(queue.get(first.job, 'user@example.com'), undefined);
});
