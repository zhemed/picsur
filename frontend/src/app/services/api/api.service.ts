import { Inject, Injectable } from '@angular/core';
import { WINDOW } from '@ng-web-apis/common';
import axios, {
  AxiosRequestConfig,
  AxiosResponse,
  AxiosResponseHeaders,
} from 'axios';
import { ApiResponseSchema } from 'picsur-shared/dist/dto/api/api.dto';
import { FileType2Ext } from 'picsur-shared/dist/dto/mimes.dto';
import {
  AsyncFailable,
  FT,
  Fail,
  Failure,
  HasFailed,
  HasSuccess,
} from 'picsur-shared/dist/types/failable';
import { ZodDtoStatic } from 'picsur-shared/dist/util/create-zod-dto';
import { ParseMime2FileType } from 'picsur-shared/dist/util/parse-mime';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { z } from 'zod';
import { ApiBuffer } from '../../models/dto/api-buffer.dto';
import { ApiError } from '../../models/dto/api-error.dto';
import { MultiPartRequest } from '../../models/dto/multi-part-request.dto';
import { Logger } from '../logger/logger.service';
import { KeyStorageService } from '../storage/key-storage.service';

/*
  Proud of this, it works so smoooth
*/

export interface RunningRequest<R> {
  uploadProgress: Observable<number>;
  downloadProgress: Observable<number>;
  result: AsyncFailable<R>;
  cancel: () => void;
}

function MapRunningRequest<R, T>(
  runningRequest: RunningRequest<R>,
  map: (r: R) => AsyncFailable<T>,
): RunningRequest<T> {
  return {
    ...runningRequest,
    result: runningRequest.result.then(async (result) => {
      if (HasFailed(result)) return result;
      return map(result);
    }),
  };
}

function CreateFailedRunningRequest<R>(failure: Failure) {
  const subject = new Subject<number>();
  subject.complete();
  return {
    uploadProgress: subject.asObservable(),
    downloadProgress: subject.asObservable(),
    result: Promise.resolve(failure),
    cancel: () => {},
  } as RunningRequest<R>;
}

/**
 * Failures are answered as `{success:false, data:{type, message}}`, where the
 * type is one of the `FT` values (and the HTTP status is 4xx/5xx). Mapping it
 * back keeps the reason available to the caller: without it a rejected login
 * would look like a broken connection instead of bad credentials.
 */
function FailureFromEnvelope(type: string, message: string): Failure {
  const failureType = Object.values(FT).includes(type as FT)
    ? (type as FT)
    : FT.Unknown;

  return Fail(failureType, message);
}

function IsOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  private readonly logger = new Logger(ApiService.name);

  private errorSubject = new Subject<ApiError>();

  public get networkErrors() {
    return this.errorSubject.asObservable();
  }

  constructor(
    private readonly keyService: KeyStorageService,
    @Inject(WINDOW) private readonly windowRef: Window,
  ) {}

  public get<T extends z.ZodObject>(
    type: ZodDtoStatic<T>,
    url: string,
  ): RunningRequest<z.infer<T>> {
    return this.fetchSafeJson(type, url, { method: 'GET' });
  }

  public head(url: string): RunningRequest<AxiosResponseHeaders> {
    return this.fetchHead(url, { method: 'HEAD' });
  }

  public getBuffer(url: string): RunningRequest<ApiBuffer> {
    return this.fetchBuffer(url, { method: 'GET' });
  }

  public post<T extends z.ZodObject, W extends z.ZodObject>(
    sendType: ZodDtoStatic<T>,
    receiveType: ZodDtoStatic<W>,
    url: string,
    data: z.infer<T>,
  ): RunningRequest<z.infer<W>> {
    const sendSchema = sendType.zodSchema;

    const validateResult = sendSchema.safeParse(data);
    if (!validateResult.success) {
      return CreateFailedRunningRequest(
        Fail(FT.SysValidation, 'api.somethingWentWrong', validateResult.error),
      );
    }

    return this.fetchSafeJson(receiveType, url, {
      method: 'POST',
      data: validateResult.data,
    });
  }

  public postEmpty<T extends z.ZodObject>(
    type: ZodDtoStatic<T>,
    url: string,
  ): RunningRequest<z.infer<T>> {
    return this.fetchSafeJson(type, url, { method: 'POST' });
  }

  public postForm<T extends z.ZodObject>(
    receiveType: ZodDtoStatic<T>,
    url: string,
    data: MultiPartRequest,
  ): RunningRequest<z.infer<T>> {
    return this.fetchSafeJson(receiveType, url, {
      method: 'POST',
      data: data.createFormData(),
    });
  }

  private fetchSafeJson<T extends z.ZodObject>(
    type: ZodDtoStatic<T>,
    url: string,
    options: AxiosRequestConfig,
  ): RunningRequest<z.infer<T>> {
    const resultSchema = ApiResponseSchema(type.zodSchema);
    type resultType = z.infer<typeof resultSchema>;

    const response = this.fetch(url, {
      ...options,
      responseType: 'json',
    });

    return MapRunningRequest(response, async (r) => {
      const body = r.data as resultType | undefined;
      const validateResult = resultSchema.safeParse(body);
      if (!validateResult.success) {
        // An unparseable body means we never reached the API (proxy error
        // page, truncated answer). A body that *is* an envelope but does not
        // match the expected data is a contract problem instead.
        const isEnvelope =
          typeof body === 'object' && body !== null && 'success' in body;
        return isEnvelope
          ? Fail(
              FT.SysValidation,
              'api.somethingWentWrong',
              validateResult.error,
            )
          : Fail(
              FT.Network,
              'api.nonOkResponse',
              `status ${r.status}: ${String(validateResult.error)}`,
            );
      }

      if (validateResult.data.success === false) {
        return FailureFromEnvelope(
          validateResult.data.data.type,
          validateResult.data.data.message,
        );
      }

      return validateResult.data.data;
    });
  }

  private fetchBuffer(
    url: string,
    options: AxiosRequestConfig,
  ): RunningRequest<ApiBuffer> {
    const response = this.fetch(url, {
      ...options,
      responseType: 'arraybuffer',
    });

    return MapRunningRequest(response, async (r) => {
      if (!IsOkStatus(r.status))
        return Fail(FT.Network, 'api.nonOkResponse', r.status);

      // Axios normalises header names to lowercase, but be defensive about it:
      // without the mime type the downloaded file has no extension, and the
      // SVG/SVG download path depends on this lookup.
      const mimeType =
        (r.headers['content-type'] ?? r.headers['Content-Type'])?.toString() ??
        'other/unknown';
      let name =
        r.headers['content-disposition'] ?? r.headers['Content-Disposition'];
      if (!name) {
        name = url.split('/').pop() ?? 'unnamed';
      }

      const filetype = ParseMime2FileType(mimeType);
      if (HasSuccess(filetype)) {
        const ext = FileType2Ext(filetype.identifier);
        if (HasSuccess(ext)) {
          if (!name.endsWith(ext)) {
            name += '.' + ext;
          }
        }
      }

      return {
        buffer: r.data,
        mimeType,
        name,
      };
    });
  }

  private fetchHead(
    url: string,
    options: AxiosRequestConfig,
  ): RunningRequest<AxiosResponseHeaders> {
    const response = this.fetch(url, options);

    return MapRunningRequest(response, async (r) => {
      if (!IsOkStatus(r.status))
        return Fail(FT.Network, 'api.nonOkResponse', r.status);

      return r.headers as AxiosResponseHeaders;
    });
  }

  private fetch(
    url: string,
    options: AxiosRequestConfig,
  ): RunningRequest<AxiosResponse> {
    const key = this.keyService.get();
    const isJSON = typeof options.data === 'string';

    const headers: any = options.headers || {};
    if (key !== null)
      headers['Authorization'] = `Bearer ${this.keyService.get()}`;
    if (isJSON) headers['Content-Type'] = 'application/json';
    options.headers = headers;

    const uploadProgress = new BehaviorSubject<number>(0);
    const downloadProgress = new BehaviorSubject<number>(0);
    const abortController = new AbortController();

    const resultPromise: AsyncFailable<AxiosResponse> = (async () => {
      try {
        const result = await axios.request({
          url,
          // Failures are answered with a JSON body that carries the reason
          // (401 for a wrong password, 403, 404, ...). Letting axios throw on
          // those would turn every one of them into "network error" and throw
          // the reason away - the consumers below decide what a status means.
          validateStatus: () => true,
          onDownloadProgress: (e) => {
            downloadProgress.next((e.loaded / (e.total ?? 1000000)) * 100);
          },
          onUploadProgress: (e) => {
            uploadProgress.next((e.loaded / (e.total ?? 1000000)) * 100);
          },
          signal: abortController.signal,
          ...options,
        });

        uploadProgress.complete();
        downloadProgress.complete();

        return result;
      } catch (e) {
        return Fail(FT.Network, e);
      }
    })();

    return {
      result: resultPromise,
      uploadProgress,
      downloadProgress,
      cancel: () => {
        abortController.abort();
        uploadProgress.complete();
        downloadProgress.complete();
      },
    };
  }
}
