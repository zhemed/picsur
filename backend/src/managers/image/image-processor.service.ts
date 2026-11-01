import { Injectable } from '@nestjs/common';
import {
  AnimFileType,
  FileType,
  ImageFileType,
  SupportedFileTypeCategory,
} from 'picsur-shared/dist/dto/mimes.dto';

import {
  AsyncFailable,
  Fail,
  FT,
  HasFailed,
} from 'picsur-shared/dist/types/failable';
import { ParseFileType } from 'picsur-shared/dist/util/parse-mime';
import { ImageConverterService } from './image-converter.service.js';
import { ImageResult } from './imageresult.js';

@Injectable()
export class ImageProcessorService {
  constructor(private readonly imageConverter: ImageConverterService) {}

  public async process(
    image: Buffer,
    filetype: FileType,
  ): AsyncFailable<ImageResult> {
    if (filetype.category === SupportedFileTypeCategory.Image) {
      return await this.processStill(image, filetype);
    } else if (filetype.category === SupportedFileTypeCategory.Animation) {
      return await this.processAnimation(image, filetype);
    } else if (filetype.category === SupportedFileTypeCategory.Video) {
      return this.processVideo(image, filetype);
    } else {
      return Fail(FT.SysValidation, 'Unsupported mime type');
    }
  }

  private async processStill(
    image: Buffer,
    filetype: FileType,
  ): AsyncFailable<ImageResult> {
    // SVG has no internal representation to transcode to: it is stored as-is
    // (already sanitized by SvgSecurityService) and rasterized on demand by
    // the converter. Sending it through sharp here would either lose the
    // vector data or require keeping a second, unsanitized copy around.
    if (filetype.identifier === ImageFileType.SVG) {
      return {
        image,
        filetype: filetype.identifier,
      };
    }

    const outputFileType = ParseFileType(ImageFileType.QOI);
    if (HasFailed(outputFileType)) return outputFileType;

    return this.imageConverter.convert(image, filetype, outputFileType, {});
  }

  private async processAnimation(
    image: Buffer,
    filetype: FileType,
  ): AsyncFailable<ImageResult> {
    const outputFileType = ParseFileType(AnimFileType.WEBP);
    if (HasFailed(outputFileType)) return outputFileType;

    return this.imageConverter.convert(image, filetype, outputFileType, {
      lossless: true,
      effort: 0,
    });
  }

  /**
   * Videos are stored exactly as uploaded.
   *
   * There is no video pipeline (no ffmpeg, no thumbnails, no transcoding), so
   * the master file *is* the original bytes. Decoding them with sharp would
   * fail and transcoding is out of scope for the upload-and-direct-link tier.
   */
  private async processVideo(
    image: Buffer,
    filetype: FileType,
  ): AsyncFailable<ImageResult> {
    return {
      image,
      filetype: filetype.identifier,
    };
  }
}
