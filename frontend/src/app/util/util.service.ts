import { Injectable } from '@angular/core';
import {
  FileType2Ext,
  ImageFileType,
  SupportedFileTypeCategory,
  SupportedFileTypes,
} from 'picsur-shared/dist/dto/mimes.dto';
import { HasFailed } from 'picsur-shared/dist/types/failable';
import { ParseFileType } from 'picsur-shared/dist/util/parse-mime';
import { Logger } from '../services/logger/logger.service';

@Injectable({
  providedIn: 'any',
})
export class UtilService {
  private readonly logger = new Logger(UtilService.name);

  public downloadBuffer(
    buffer: ArrayBuffer | string,
    filename: string,
    filetype = 'application/octet-stream',
  ) {
    const objectURL = URL.createObjectURL(
      new Blob([buffer], { type: filetype }),
    );

    const a = document.createElement('a');
    a.href = objectURL;
    a.download = filename;
    a.target = '_self';
    a.click();

    // The browser keeps its own reference once the download started, so the
    // blob URL can go away - just not in the same task as the click.
    setTimeout(() => URL.revokeObjectURL(objectURL), 0);
  }

  public getBaseFormatOptions() {
    const newOptions: {
      value: string;
      key: string;
    }[] = [];
    const seenExtensions = new Set<string>();

    newOptions.push(
      ...SupportedFileTypes.flatMap((mime) => {
        const parsed = ParseFileType(mime);
        if (HasFailed(parsed)) return [];

        // Videos are never converted: they are served as the original upload
        // only, so offering MP4/WEBM in the image format list would let a user
        // pick a format the backend answers with 400.
        if (parsed.category === SupportedFileTypeCategory.Video) return [];

        // SVG is not a transcode target: it is only downloadable as the
        // original when the upload itself was an SVG.
        if (mime === ImageFileType.SVG) return [];

        let ext = FileType2Ext(mime);
        if (HasFailed(ext)) ext = 'Error';

        // Multiple mime types can share one extension (image:webp vs
        // anim:webp); showing the same option twice is just noise.
        if (seenExtensions.has(ext)) return [];
        seenExtensions.add(ext);

        return {
          value: ext.toUpperCase(),
          key: mime,
        };
      }),
    );

    return newOptions;
  }

  public async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
