import { randomUUID } from 'node:crypto';
import type { JobStatusType, SheetGeometryType } from './types.js';

export type JobRecord = JobStatusType & {
    owner: string;
    completed?: number;
    /** Phase 1 keeps the artifact in memory. Phase 2 moves it to MinIO. */
    artifact?: { body: Buffer; contentType: string };
};

export type JobContext = {
    /** Report progress from inside a worker. */
    progress: (fraction: number, step?: string) => void;
};

export type JobWorker = (ctx: JobContext) => Promise<{ body: Buffer; contentType: string }>;

/**
 * In-process job queue. No Redis: at PRINT_CONCURRENCY=1 a queue is a promise
 * chain and a Map, and a fourteenth container to babysit buys nothing. The cost
 * is that in-flight jobs do not survive a restart — acceptable for a print job
 * you would simply re-run.
 */
export class Queue {
    private jobs = new Map<string, JobRecord>();
    private pending: string[] = [];
    private workers = new Map<string, JobWorker>();
    private running = 0;

    constructor(
        private concurrency: number,
        private ttlMs: number,
    ) {}

    submit(owner: string, worker: JobWorker, sheet?: SheetGeometryType): JobRecord {
        const job: JobRecord = {
            job: randomUUID(),
            status: 'queued',
            progress: 0,
            created: new Date().toISOString(),
            owner,
            sheet,
        };

        this.jobs.set(job.job, job);
        this.workers.set(job.job, worker);
        this.pending.push(job.job);

        this.pump();

        return job;
    }

    /**
     * Jobs are readable only by the identity that submitted them. Without this a
     * valid token for any user would expose every other user's sheets.
     */
    get(id: string, owner: string): JobRecord | undefined {
        const job = this.jobs.get(id);
        if (!job || job.owner !== owner) return undefined;
        return job;
    }

    get depth(): number {
        return this.pending.length;
    }

    get active(): number {
        return this.running;
    }

    private pump(): void {
        while (this.running < this.concurrency && this.pending.length) {
            const id = this.pending.shift();
            if (!id) break;
            void this.run(id);
        }
    }

    private async run(id: string): Promise<void> {
        const job = this.jobs.get(id);
        const worker = this.workers.get(id);
        if (!job || !worker) return;

        this.workers.delete(id);
        this.running++;

        job.status = 'running';
        job.progress = 0;

        try {
            const artifact = await worker({
                progress: (fraction: number, step?: string) => {
                    job.progress = Math.min(1, Math.max(0, fraction));
                    if (step) job.step = step;
                },
            });

            job.artifact = artifact;
            job.status = 'complete';
            job.progress = 1;
        } catch (err) {
            job.status = 'failed';
            job.error = err instanceof Error ? err.message : String(err);
        } finally {
            job.completed = Date.now();
            this.running--;
            this.sweep();
            this.pump();
        }
    }

    /** Drop finished jobs past their TTL so a long-lived container does not grow without bound. */
    private sweep(): void {
        const cutoff = Date.now() - this.ttlMs;

        for (const [id, job] of this.jobs) {
            if (job.completed && job.completed < cutoff) {
                this.jobs.delete(id);
                this.workers.delete(id);
            }
        }
    }
}
