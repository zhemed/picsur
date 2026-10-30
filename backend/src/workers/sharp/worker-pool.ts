import { Logger } from '@nestjs/common';
import { ChildProcess, fork } from 'child_process';
import { availableParallelism } from 'os';
import pTimeout from 'p-timeout';
import { dirname, join as pathJoin } from 'path';
import {
  AsyncFailable,
  Fail,
  Failable,
  FT,
  HasFailed,
} from 'picsur-shared/dist/types/failable';
import { ReadMaxImagePixelsFromEnv } from 'picsur-shared/dist/util/image-pixel-limit';
import { SharpWorkerRecieveMessage } from './sharp.message.js';

const moduleURL = new URL(import.meta.url);
const __dirname = dirname(moduleURL.pathname);

/**
 * How many conversion workers one pool may have leased (or being forked) at
 * the same time. There is deliberately no environment variable for this: the
 * number must stay a property of the code, not of the deployment.
 */
const MAX_CONCURRENT_WORKERS = Math.max(
  1,
  Math.min(4, availableParallelism()),
);

/** How long an idle worker is kept alive before it gets killed. */
const IDLE_WORKER_TTL_MS = 60 * 1000;

/** Child process entry point; it sits next to this module in `dist/`. */
const WORKER_PATH = pathJoin(__dirname, 'sharp.worker.js');

/** A worker that one `SharpWrapper` task currently owns. */
export interface WorkerLease {
  /** Stable id of the worker behind this lease, also used in log lines. */
  readonly workerID: number;
  /** Memory limit the worker was forked with; leases never cross pools. */
  readonly memoryLimit: number;
  /** The IPC child process this lease owns for the duration of one task. */
  readonly child: ChildProcess;
}

interface Waiter {
  readonly timeoutMs: number;
  readonly promise: Promise<Failable<WorkerLease>>;
  readonly settle: (result: Failable<WorkerLease>) => void;
  settled: boolean;
}

/**
 * One live child process.
 *
 * `active` in the owning pool contains every slot that is either leased or
 * still being forked (forking counts against the concurrency limit, otherwise
 * a burst of requests could spawn more workers than the limit).
 */
interface WorkerSlot {
  readonly workerID: number;
  readonly memoryLimit: number;
  readonly child: ChildProcess;
  ready: boolean;
  leased: boolean;
  closed: boolean;
  idleTimer: NodeJS.Timeout | null;
  lease: WorkerLease | null;
}

interface PoolState {
  readonly memoryLimit: number;
  readonly idle: WorkerSlot[];
  readonly active: Set<WorkerSlot>;
  readonly waiters: Waiter[];
}

interface LeasedSlot {
  readonly state: PoolState;
  readonly slot: WorkerSlot;
}

function DescribeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

class SharpWorkerPoolImpl {
  private readonly logger = new Logger('SharpWorkerPool');
  private readonly pools = new Map<string, PoolState>();
  private readonly leasedSlots = new Map<number, LeasedSlot>();
  private nextWorkerID = 1;

  constructor() {
    // The workers are not part of the app's Nest lifecycle; make sure they do
    // not outlive the main process. Deliberately `exit` only (best effort and
    // synchronous): do not install SIGTERM handlers here, that would interfere
    // with the existing shutdown path.
    process.once('exit', () => this.killAll());
  }

  /**
   * Get a ready worker for one task. The returned lease must be handed back
   * with `release` (task succeeded) or `destroy` (task failed/timed out).
   *
   * Fails when a slot becomes ready too slowly, when there is no forkable
   * worker, or when waiting in the FIFO queue exceeds `timeoutMs`.
   */
  public async acquire(
    memoryLimit: number,
    timeoutMs: number,
  ): AsyncFailable<WorkerLease> {
    const waitMs = Math.max(1, timeoutMs);
    const state = this.getPool(memoryLimit);

    const idle = this.takeIdleSlot(state);
    if (idle !== null) {
      this.logger.verbose(
        `Reusing idle sharp worker #${idle.workerID} (${memoryLimit}MB)`,
      );
      return this.leaseSlot(state, idle);
    }

    if (state.active.size < MAX_CONCURRENT_WORKERS) {
      const slot = this.forkSlot(state);
      if (HasFailed(slot)) return slot;

      try {
        await pTimeout(this.waitUntilReady(slot), { milliseconds: waitMs });
      } catch (error) {
        this.disposeSlot(state, slot, 'failed to become ready');
        this.drain(state);
        return Fail(FT.Internal, error);
      }

      slot.ready = true;
      return this.leaseSlot(state, slot);
    }

    const waiter = this.createWaiter(waitMs);
    state.waiters.push(waiter);

    try {
      return await pTimeout(waiter.promise, { milliseconds: waitMs });
    } catch {
      if (!waiter.settled) {
        waiter.settled = true;
        this.removeWaiter(state, waiter);
      }
      this.logger.verbose(
        `Timed out waiting for a free sharp worker (${memoryLimit}MB)`,
      );
      return Fail(FT.Internal, 'Timed out waiting for a free conversion worker');
    }
  }

  /** Return a worker whose task succeeded; it can be reused right away. */
  public release(lease: WorkerLease): void {
    const entry = this.leasedSlots.get(lease.workerID);
    if (entry === undefined) return;

    this.leasedSlots.delete(lease.workerID);
    const { state, slot } = entry;

    if (slot.closed) {
      slot.lease = null;
      this.drain(state);
      return;
    }

    this.logger.verbose(
      `Returning sharp worker #${slot.workerID} to the idle pool`,
    );
    this.parkSlot(state, slot);
    this.drain(state);
  }

  /**
   * Kill a worker whose task failed, timed out or crashed. Never put an
   * uncertain child process back into the pool.
   */
  public destroy(lease: WorkerLease, reason?: string): void {
    const entry = this.leasedSlots.get(lease.workerID);
    if (entry === undefined) return;

    this.leasedSlots.delete(lease.workerID);
    const { state, slot } = entry;

    this.disposeSlot(state, slot, reason);
    this.drain(state);
  }

  private getPool(memoryLimit: number): PoolState {
    const key = String(memoryLimit);
    let state = this.pools.get(key);
    if (state === undefined) {
      state = {
        memoryLimit,
        idle: [],
        active: new Set(),
        waiters: [],
      };
      this.pools.set(key, state);
    }
    return state;
  }

  private createWaiter(timeoutMs: number): Waiter {
    let settle!: (result: Failable<WorkerLease>) => void;
    const promise = new Promise<Failable<WorkerLease>>((resolve) => {
      settle = resolve;
    });
    return { timeoutMs, promise, settle, settled: false };
  }

  private removeWaiter(state: PoolState, waiter: Waiter): void {
    const index = state.waiters.indexOf(waiter);
    if (index >= 0) state.waiters.splice(index, 1);
  }

  private settleWaiter(
    state: PoolState,
    waiter: Waiter,
    result: Failable<WorkerLease>,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.removeWaiter(state, waiter);
    waiter.settle(result);
  }

  private finishWaiter(waiter: Waiter, result: Failable<WorkerLease>): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.settle(result);
  }

  /** Hand out idle workers / fork replacements to the FIFO queue. */
  private drain(state: PoolState): void {
    while (state.waiters.length > 0) {
      const waiter = state.waiters[0];

      const idle = this.takeIdleSlot(state);
      if (idle !== null) {
        this.settleWaiter(state, waiter, this.leaseSlot(state, idle));
        continue;
      }

      if (state.active.size >= MAX_CONCURRENT_WORKERS) return;

      this.removeWaiter(state, waiter);
      const slot = this.forkSlot(state);
      if (HasFailed(slot)) {
        this.finishWaiter(waiter, slot);
        continue;
      }

      void this.readyWaiterSlot(state, slot, waiter);
    }
  }

  private async readyWaiterSlot(
    state: PoolState,
    slot: WorkerSlot,
    waiter: Waiter,
  ): Promise<void> {
    try {
      await pTimeout(this.waitUntilReady(slot), {
        milliseconds: waiter.timeoutMs,
      });
    } catch (error) {
      this.disposeSlot(state, slot, 'failed to become ready');
      this.finishWaiter(waiter, Fail(FT.Internal, error));
      this.drain(state);
      return;
    }

    if (waiter.settled) {
      // The request behind this waiter timed out while we were forking;
      // keep the worker around for the next request instead of killing it.
      this.parkSlot(state, slot);
    } else {
      slot.ready = true;
      this.finishWaiter(waiter, this.leaseSlot(state, slot));
    }

    this.drain(state);
  }

  private takeIdleSlot(state: PoolState): WorkerSlot | null {
    while (state.idle.length > 0) {
      const slot = state.idle.shift();
      if (slot === undefined) return null;

      if (slot.idleTimer !== null) {
        clearTimeout(slot.idleTimer);
        slot.idleTimer = null;
      }

      if (
        slot.closed ||
        slot.child.exitCode !== null ||
        slot.child.signalCode !== null
      ) {
        this.disposeSlot(state, slot, 'exited while idle');
        continue;
      }

      state.active.add(slot);
      return slot;
    }

    return null;
  }

  private parkSlot(state: PoolState, slot: WorkerSlot): void {
    if (slot.closed) return;

    slot.leased = false;
    slot.lease = null;
    state.active.delete(slot);

    if (!state.idle.includes(slot)) state.idle.push(slot);

    if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(
      () => this.expireIdleSlot(state, slot),
      IDLE_WORKER_TTL_MS,
    );
    // Do not keep the process alive just because a worker is idling; the
    // process exit handler kills the workers anyway.
    slot.idleTimer.unref();
  }

  private expireIdleSlot(state: PoolState, slot: WorkerSlot): void {
    slot.idleTimer = null;
    if (slot.closed) return;

    const index = state.idle.indexOf(slot);
    if (index < 0) return;

    this.logger.verbose(
      `Closing sharp worker #${slot.workerID} after ${IDLE_WORKER_TTL_MS}ms idle`,
    );
    this.disposeSlot(state, slot, 'idle timeout');
    this.drain(state);
  }

  private leaseSlot(state: PoolState, slot: WorkerSlot): WorkerLease {
    const lease: WorkerLease = {
      workerID: slot.workerID,
      memoryLimit: slot.memoryLimit,
      child: slot.child,
    };

    slot.leased = true;
    slot.lease = lease;
    this.leasedSlots.set(lease.workerID, { state, slot });
    return lease;
  }

  private forkSlot(state: PoolState): Failable<WorkerSlot> {
    let child: ChildProcess;
    try {
      child = fork(WORKER_PATH, {
        serialization: 'advanced',
        env: {
          MEMORY_LIMIT_MB: state.memoryLimit.toString(),
          // Last line of defence for oversized input (issue #107); the main
          // process normally rejects it before a worker is ever spawned.
          MAX_IMAGE_PIXELS: ReadMaxImagePixelsFromEnv().toString(),
          NODE_OPTIONS: '--no-warnings',
        },
        stdio: 'overlapped',
      });
    } catch (error) {
      this.logger.error(`Failed to fork sharp worker: ${DescribeError(error)}`);
      return Fail(FT.Internal, error);
    }

    const slot: WorkerSlot = {
      workerID: this.nextWorkerID++,
      memoryLimit: state.memoryLimit,
      child,
      ready: false,
      leased: false,
      closed: false,
      idleTimer: null,
      lease: null,
    };
    state.active.add(slot);

    // NOTE: we cannot call `.on(...)` on the fork() stdio streams directly.
    // `@fastify/busboy` (pulled in by `@fastify/multipart` >= 10) ships a broken
    // module augmentation of the bare `'stream'` module, which collapses the
    // `Readable` interface down to a single `'limit'` overload. Widening to
    // `NodeJS.ReadableStream` restores the normal event signatures.
    // These log listeners live for the whole worker lifetime (not per task):
    // the pool owns the child process, so attach them exactly once here.
    const stdout = child.stdout as NodeJS.ReadableStream | null;
    const stderr = child.stderr as NodeJS.ReadableStream | null;
    stdout?.on('data', (data: Buffer) => {
      this.logger.verbose(`Worker #${slot.workerID} log: ${data}`);
    });
    stderr?.on('data', (data: Buffer) => {
      this.logger.warn(`Worker #${slot.workerID} error: ${data}`);
    });

    child.on('error', (error: Error) => {
      this.logger.error(
        `Worker #${slot.workerID} error: ${DescribeError(error)}`,
      );
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleSlotExit(state, slot, code, signal);
    });

    // Spawns are rare (first task, after a failure, after the idle TTL), so
    // this stays visible in production logs: it is the operator-visible proof
    // that a warm worker is being reused instead of forked per conversion.
    this.logger.log(
      `Forked sharp worker #${slot.workerID} (${state.memoryLimit}MB, max ${MAX_CONCURRENT_WORKERS} concurrent)`,
    );
    return slot;
  }

  private waitUntilReady(slot: WorkerSlot): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (slot.closed) {
        reject(new Error('Worker exited before it became ready'));
        return;
      }

      const child = slot.child;
      let onMessage: (message: SharpWorkerRecieveMessage) => void;
      let onExit: () => void;
      let onError: (error: Error) => void;

      const cleanup = () => {
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };

      onMessage = (message: SharpWorkerRecieveMessage) => {
        if (message?.type === 'ready') {
          cleanup();
          resolve();
        }
      };
      onExit = () => {
        cleanup();
        reject(new Error('Worker exited before it became ready'));
      };
      onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      child.on('message', onMessage);
      child.on('exit', onExit);
      child.on('error', onError);
    });
  }

  private handleSlotExit(
    state: PoolState,
    slot: WorkerSlot,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (slot.closed) return;

    slot.ready = false;
    this.logger.verbose(
      `Sharp worker #${slot.workerID} exited with code ${code} and signal ${signal}`,
    );
    this.disposeSlot(state, slot, 'exited');
    // A task may be queued behind the worker that just died; fill the vacancy.
    this.drain(state);
  }

  private disposeSlot(
    state: PoolState,
    slot: WorkerSlot,
    reason?: unknown,
  ): void {
    if (slot.idleTimer !== null) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }

    const idleIndex = state.idle.indexOf(slot);
    if (idleIndex >= 0) state.idle.splice(idleIndex, 1);
    state.active.delete(slot);
    this.leasedSlots.delete(slot.workerID);

    if (slot.closed) return;

    slot.closed = true;
    slot.ready = false;
    slot.leased = false;
    slot.lease = null;

    const detail = typeof reason === 'string' ? `: ${reason}` : '';
    this.logger.verbose(`Destroying sharp worker #${slot.workerID}${detail}`);

    try {
      slot.child.kill();
    } catch (error) {
      this.logger.verbose(
        `Could not kill sharp worker #${slot.workerID}: ${DescribeError(error)}`,
      );
    }
  }

  private killAll(): void {
    for (const state of this.pools.values()) {
      for (const slot of state.active) {
        try {
          slot.child.kill();
        } catch {
          /* best effort while the process is going down */
        }
      }
      for (const slot of state.idle) {
        try {
          slot.child.kill();
        } catch {
          /* best effort while the process is going down */
        }
      }
    }
  }
}

/**
 * Process-wide conversion worker pool. It is shared by every `SharpWrapper`
 * (and therefore by every conversion) in this process, which is what makes
 * reusing a warm child process possible.
 */
export const SharpWorkerPool = new SharpWorkerPoolImpl();
