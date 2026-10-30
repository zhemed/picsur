import { Logger } from '@nestjs/common';
import { ChildProcess } from 'child_process';
import pTimeout from 'p-timeout';
import { FileType } from 'picsur-shared/dist/dto/mimes.dto';
import {
  AsyncFailable,
  Fail,
  Failable,
  FT,
  HasFailed,
} from 'picsur-shared/dist/types/failable';
import { DecodeWorkerFailure } from 'picsur-shared/dist/util/image-pixel-limit';
import { Sharp, SharpOptions } from 'sharp';
import {
  SharpWorkerFailureMessage,
  SharpWorkerFinishOptions,
  SharpWorkerOperation,
  SharpWorkerRecieveMessage,
  SharpWorkerResultMessage,
  SharpWorkerSendMessage,
  SupportedSharpWorkerFunctions,
} from './sharp/sharp.message.js';
import {
  SharpWorkerPool,
  WorkerLease,
} from './sharp/worker-pool.js';
import { SharpResult } from './sharp/universal-sharp.js';

/**
 * One conversion task.
 *
 * The task handle itself is still created per conversion, but the child
 * process it talks to now comes from the process-wide `SharpWorkerPool`
 * instead of being forked and killed per conversion. `start` / `operation` /
 * `finish` stay the public API so callers (image-converter.service.ts) do not
 * change.
 */
export class SharpWrapper {
  private readonly workerID: number = Math.floor(Math.random() * 100000);
  private readonly logger: Logger = new Logger('SharpWrapper' + this.workerID);

  private lease: WorkerLease | null = null;
  private child: ChildProcess | null = null;
  private taskClosed = false;
  private taskCloseReason: unknown = null;
  private rejectFinish: ((reason?: unknown) => void) | null = null;
  private finishListener:
    | ((message: SharpWorkerRecieveMessage) => void)
    | null = null;

  constructor(
    private readonly instance_timeout: number,
    private readonly memory_limit: number,
  ) {}

  public async start(
    image: Buffer,
    filetype: FileType,
    sharpOptions?: SharpOptions,
  ): AsyncFailable<true> {
    if (this.lease) {
      return Fail(FT.Internal, 'Worker is already initialized');
    }

    const acquired = await SharpWorkerPool.acquire(
      this.memory_limit,
      this.instance_timeout,
    );
    if (HasFailed(acquired)) {
      return acquired;
    }

    this.lease = acquired;
    this.child = acquired.child;
    this.taskClosed = false;
    this.taskCloseReason = null;
    this.child.once('close', this.onTaskClose);

    const hasSent = this.sendToWorker({
      type: 'init',
      image,
      filetype,
      options: sharpOptions,
    });
    if (HasFailed(hasSent)) {
      this.destroyLease(hasSent.getReason());
      return hasSent;
    }

    this.logger.verbose(
      `Worker ${this.workerID} initialized with ${this.instance_timeout}ms timeout and ${this.memory_limit}MB memory limit`,
    );

    return true;
  }

  public operation<Operation extends SupportedSharpWorkerFunctions>(
    operation: Operation,
    ...parameters: Parameters<Sharp[Operation]>
  ): Failable<true> {
    if (!this.lease) {
      return Fail(FT.Internal, 'Worker is not initialized');
    }

    const hasSent = this.sendToWorker({
      type: 'operation',
      operation: {
        name: operation,
        parameters,
      } as SharpWorkerOperation,
    });
    if (HasFailed(hasSent)) {
      this.destroyLease(hasSent.getReason());
      return hasSent;
    }

    return true;
  }

  public async finish(
    targetFiletype: FileType,
    options?: SharpWorkerFinishOptions,
  ): AsyncFailable<SharpResult> {
    if (!this.lease || !this.child) {
      return Fail(FT.Internal, 'Worker is not initialized');
    }

    const hasSent = this.sendToWorker({
      type: 'finish',
      filetype: targetFiletype,
      options: options ?? {},
    });
    if (HasFailed(hasSent)) {
      this.destroyLease(hasSent.getReason());
      return hasSent;
    }

    try {
      const finishPromise = new Promise<
        SharpWorkerResultMessage | SharpWorkerFailureMessage
      >((resolve, reject) => {
        if (this.taskClosed) {
          return reject(this.taskCloseReason ?? 'Worker closed');
        }

        this.rejectFinish = reject;

        const listener = (message: SharpWorkerRecieveMessage) => {
          this.clearFinishWait();
          if (message.type === 'result') {
            resolve(message);
          } else reject('Unknown message type');
        };

        this.finishListener = listener;
        this.child?.once('message', listener);
      });

      const result = await pTimeout(finishPromise, {
        milliseconds: this.instance_timeout,
      });

      this.logger.verbose(
        `Worker ${this.workerID} finished in ${result.processingTime}ms`,
      );

      // The worker reports user facing problems (oversized or undecodable
      // images) as a reason string; turn it back into a Failure so the client
      // gets a readable 4xx instead of "Worker closed" / 500 (issue #107).
      if (result.failure !== undefined) {
        this.destroyLease(result.failure);

        const reason = DecodeWorkerFailure(result.failure);
        if (reason !== undefined) {
          this.logger.verbose(
            `Worker ${this.workerID} rejected input: ${reason}`,
          );
          return Fail(FT.UsrValidation, reason);
        }

        return Fail(FT.Internal, result.failure);
      }

      // Task succeeded: the worker has cleared its state and goes back to the
      // idle pool for the next conversion.
      this.releaseLease();
      return result.result;
    } catch (error) {
      this.destroyLease(error);
      return Fail(FT.Internal, error);
    }
  }

  private readonly onTaskClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    this.logger.verbose(
      `Worker ${this.workerID} exited with code ${code} and signal ${signal}`,
    );

    this.taskClosed = true;
    this.taskCloseReason = 'Worker closed';

    const reject = this.rejectFinish;
    this.clearFinishWait();
    reject?.('Worker closed');
  };

  /** Drop the listeners that belong to this task, leave the pool's in place. */
  private clearFinishWait(): void {
    if (this.child && this.finishListener) {
      this.child.removeListener('message', this.finishListener);
    }
    this.finishListener = null;
    this.rejectFinish = null;
  }

  private detachTaskListeners(): void {
    if (this.child) {
      this.child.removeListener('close', this.onTaskClose);
    }
  }

  /** Task finished normally: give the worker back to the pool. */
  private releaseLease(): void {
    this.clearFinishWait();
    this.detachTaskListeners();

    const lease = this.lease;
    this.lease = null;
    this.child = null;
    if (lease) SharpWorkerPool.release(lease);
  }

  /** Task failed or timed out: never reuse that worker, kill it. */
  private destroyLease(reason?: unknown): void {
    this.clearFinishWait();
    this.detachTaskListeners();

    const lease = this.lease;
    this.lease = null;
    this.child = null;
    if (lease) {
      SharpWorkerPool.destroy(
        lease,
        typeof reason === 'string' ? reason : undefined,
      );
    }
  }

  private sendToWorker(message: SharpWorkerSendMessage): Failable<true> {
    if (!this.child) {
      return Fail(FT.Internal, 'Worker is not initialized');
    }

    try {
      this.child.send(message);
    } catch (error) {
      return Fail(FT.Internal, error);
    }

    return true;
  }
}
