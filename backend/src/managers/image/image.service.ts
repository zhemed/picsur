import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { fileTypeFromBuffer, FileTypeResult } from 'file-type';
import isSvg from 'is-svg';
import { ImageRequestParams } from 'picsur-shared/dist/dto/api/image.dto';
import { ImageEntryVariant } from 'picsur-shared/dist/dto/image-entry-variant.enum';
import {
    AnimFileType,
    FileType,
    ImageFileType,
    Mime2FileType,
    SupportedFileTypeCategory,
} from 'picsur-shared/dist/dto/mimes.dto';
import { SysPreference } from 'picsur-shared/dist/dto/sys-preferences.enum';
import { UsrPreference } from 'picsur-shared/dist/dto/usr-preferences.enum';
import {
    AsyncFailable,
    Fail,
    FT,
    HasFailed,
} from 'picsur-shared/dist/types/failable';
import { FindResult } from 'picsur-shared/dist/types/find-result';
import { ParseFileType } from 'picsur-shared/dist/util/parse-mime';
import { IsQOI } from 'qoi-img';
import { ImageDBService } from '../../collections/image-db/image-db.service.js';
import { ImageFileDBService } from '../../collections/image-db/image-file-db.service.js';
import { SysPreferenceDbService } from '../../collections/preference-db/sys-preference-db.service.js';
import { UsrPreferenceDbService } from '../../collections/preference-db/usr-preference-db.service.js';
import { ImageConfigService } from '../../config/early/image.config.service.js';
import { EImageDerivativeBackend } from '../../database/entities/images/image-derivative.entity.js';
import { EImageFileBackend } from '../../database/entities/images/image-file.entity.js';
import { EImageBackend } from '../../database/entities/images/image.entity.js';
import { MutexFallBack } from '../../util/mutex-fallback.js';
import { ImageConverterService } from './image-converter.service.js';
import { ImageProcessorService } from './image-processor.service.js';
import { SvgSecurityService } from './svg-security.service.js';
import { WebPInfo } from './webpinfo/webpinfo.js';

@Injectable()
export class ImageManagerService {
  private readonly logger = new Logger(ImageManagerService.name);

  constructor(
    private readonly imagesService: ImageDBService,
    private readonly imageFilesService: ImageFileDBService,
    private readonly processService: ImageProcessorService,
    private readonly convertService: ImageConverterService,
    private readonly svgSecurity: SvgSecurityService,
    private readonly userPref: UsrPreferenceDbService,
    private readonly sysPref: SysPreferenceDbService,
    private readonly imageConfig: ImageConfigService,
  ) {}

  public async findOne(id: string): AsyncFailable<EImageBackend> {
    return await this.imagesService.findOne(id, undefined);
  }

  public async findMany(
    count: number,
    page: number,
    userid: string | undefined,
  ): AsyncFailable<FindResult<EImageBackend>> {
    return await this.imagesService.findMany(count, page, userid);
  }

  public async findAll(
    userid: string | undefined,
    count?: number,
    page?: number,
  ): AsyncFailable<{ results: EImageBackend[]; total: number }> {
    return await this.imagesService.findAll(userid, count, page);
  }

  public async update(
    id: string,
    userid: string | undefined,
    options: Partial<Pick<EImageBackend, 'file_name' | 'expires_at'>>,
  ): AsyncFailable<EImageBackend> {
    if (options.expires_at !== undefined && options.expires_at !== null) {
      if (options.expires_at < new Date()) {
        return Fail(FT.UsrValidation, 'Expiration date must be in the future');
      }
    }
    return await this.imagesService.update(id, userid, options);
  }

  public async deleteMany(
    ids: string[],
    userid: string | undefined,
  ): AsyncFailable<EImageBackend[]> {
    return await this.imagesService.delete(ids, userid);
  }

  public async deleteWithKey(
    imageId: string,
    key: string,
  ): AsyncFailable<EImageBackend> {
    return await this.imagesService.deleteWithKey(imageId, key);
  }

  public async upload(
    userid: string,
    filename: string,
    image: Buffer,
    withDeleteKey: boolean,
  ): AsyncFailable<EImageBackend> {
    const fileType = await this.getFileTypeFromBuffer(image);
    if (HasFailed(fileType)) return fileType;

    // SVG is stored verbatim, so it must be sanitized before it is written
    // anywhere. Everything else goes through the sharp transcode below, which
    // normalizes the payload.
    let uploadImage = image;
    if (fileType.identifier === ImageFileType.SVG) {
      const sanitized = this.svgSecurity.sanitize(image);
      if (HasFailed(sanitized)) return sanitized;

      uploadImage = sanitized;
    }

    // Check if need to save orignal
    const keepOriginal = await this.userPref.getBooleanPreference(
      userid,
      UsrPreference.KeepOriginal,
    );
    if (HasFailed(keepOriginal)) return keepOriginal;

    // Process
    const processResult = await this.processService.process(
      uploadImage,
      fileType,
    );
    if (HasFailed(processResult)) return processResult;

    // Strip extension from filename
    const name = (() => {
      const index = filename.lastIndexOf('.');
      if (index === -1) return filename;
      return filename.substring(0, index);
    })();

    // Save processed to db
    const imageEntity = await this.imagesService.create(
      userid,
      name,
      fileType.identifier,
      processResult,
      withDeleteKey,
    );
    if (HasFailed(imageEntity)) return imageEntity;

    const imageFileEntity = await this.imageFilesService.setFile(
      imageEntity.id,
      ImageEntryVariant.MASTER,
      processResult.image,
      processResult.filetype,
    );
    if (HasFailed(imageFileEntity)) return imageFileEntity;

    // Videos are stored verbatim as the master, so keeping a separate original
    // would write a second identical copy of a potentially 128 MB file. The
    // "keep original" preference has nothing left to do for them.
    if (keepOriginal && fileType.category !== SupportedFileTypeCategory.Video) {
      const originalFileEntity = await this.imageFilesService.setFile(
        imageEntity.id,
        ImageEntryVariant.ORIGINAL,
        uploadImage,
        fileType.identifier,
      );
      if (HasFailed(originalFileEntity)) return originalFileEntity;
    }

    return imageEntity;
  }

  public async getConverted(
    imageId: string,
    fileType: string,
    options: ImageRequestParams,
  ): AsyncFailable<EImageDerivativeBackend> {
    const targetFileType = ParseFileType(fileType);
    if (HasFailed(targetFileType)) return targetFileType;

    // A video is not an image: the master is the untouched upload, and there is
    // no pipeline that could transcode it. Serving it back in its own container
    // is the only supported request, and it needs neither a derivative nor the
    // edit parameters (which are meaningless for a video).
    if (targetFileType.category === SupportedFileTypeCategory.Video) {
      // Check the master type before reading it: a 128 MB video (or any other
      // master) must not be pulled into memory just to answer 400.
      const masterFileType = await this.getMasterFileType(imageId);
      if (HasFailed(masterFileType)) return masterFileType;

      if (masterFileType.category !== SupportedFileTypeCategory.Video) {
        return Fail(
          FT.UsrValidation,
          'Unsupported conversion',
          'Cannot convert an image to a video format',
        );
      }

      if (masterFileType.identifier !== targetFileType.identifier) {
        // mp4 -> webm (and the other way around) would need ffmpeg, which this
        // tier does not have. Say so instead of failing inside the converter.
        return Fail(
          FT.UsrValidation,
          'Unsupported conversion',
          'Video formats cannot be converted',
        );
      }

      const master = await this.getMasterFile(imageId);
      if (HasFailed(master)) return master;

      // Returned as-is: putting this in the derivative table would duplicate
      // the whole file just to hand back identical bytes.
      return {
        key: this.getConvertHash({ mime: fileType, ...options }),
        filetype: masterFileType.identifier,
        data: master.data,
      } as EImageDerivativeBackend;
    }

    const allow_editing = await this.sysPref.getBooleanPreference(
      SysPreference.AllowEditing,
    );
    if (HasFailed(allow_editing)) return allow_editing;

    const editOptions = allow_editing ? options : {};
    const wantsEdits = Object.keys(editOptions).length > 0;

    // SVG can only be served from an SVG master: it is a vector format, and
    // rasterizing into SVG is not a thing. Requesting it for a raster image is
    // a bad request rather than an internal conversion error.
    if (targetFileType.identifier === ImageFileType.SVG) {
      const masterFileType = await this.getMasterFileType(imageId);
      if (HasFailed(masterFileType)) return masterFileType;

      if (masterFileType.identifier !== ImageFileType.SVG) {
        return Fail(
          FT.UsrValidation,
          'Unsupported conversion',
          'Cannot convert a raster image to SVG',
        );
      }

      if (wantsEdits) {
        // An SVG is served verbatim and there is no pipeline that could apply
        // width/quality/... to a vector target. Say so instead of letting the
        // converter fail and reporting "the image appears to be corrupt"
        // (audit A-11): the upload is fine, only the request is impossible.
        return Fail(
          FT.UsrValidation,
          'Unsupported conversion',
          'SVG images cannot be transformed, request the image without edit parameters',
        );
      }
    }

    const converted_key = this.getConvertHash({ mime: fileType, ...options });

    return MutexFallBack(
      // The mutex key must include the image: with only the conversion hash,
      // a request for image B with the same options waited for image A's
      // conversion (audit A-13). The derivative cache key itself stays shared.
      `${imageId}:${converted_key}`,
      () => {
        return this.imageFilesService.getDerivative(imageId, converted_key);
      },
      async () => {
        const masterImage = await this.getMasterFile(imageId);
        if (HasFailed(masterImage)) return masterImage;

        const sourceFileType = ParseFileType(masterImage.filetype);
        if (HasFailed(sourceFileType)) return sourceFileType;

        // A video master cannot be handed to sharp: there is no raster source
        // to convert, so /i/<video>.webp is a bad request rather than an
        // internal conversion error.
        if (sourceFileType.category === SupportedFileTypeCategory.Video) {
          return Fail(
            FT.UsrValidation,
            'Unsupported conversion',
            'Videos can only be served in their own format',
          );
        }

        const startTime = Date.now();
        const convertResult = await this.convertService.convert(
          masterImage.data,
          sourceFileType,
          targetFileType,
          editOptions,
        );
        if (HasFailed(convertResult)) return convertResult;

        this.logger.verbose(
          `Converted ${imageId} from ${sourceFileType.identifier} to ${
            targetFileType.identifier
          } in ${Date.now() - startTime}ms`,
        );

        // The converter hands the master buffer back untouched when the
        // requested format *is* the master format and no edits were asked for.
        // Storing that would write a byte identical copy of the whole file into
        // the derivative table (audit A-12), so serve it directly instead.
        if (convertResult.image === masterImage.data) {
          return {
            key: converted_key,
            filetype: convertResult.filetype,
            data: convertResult.image,
          } as EImageDerivativeBackend;
        }

        const maxDerivatives = this.imageConfig.getMaxDerivativesPerImage();
        if (maxDerivatives > 0) {
          const stored = await this.imageFilesService.countDerivatives(imageId);
          if (HasFailed(stored)) return stored;

          if (stored >= maxDerivatives) {
            // Still serve the conversion, just do not cache it: the cap exists
            // to bound database growth, not to break rendering (audit A-8).
            this.logger.warn(
              `Image ${imageId} already has ${stored} derivatives (limit ${maxDerivatives}), not storing another one`,
            );
            return {
              key: converted_key,
              filetype: convertResult.filetype,
              data: convertResult.image,
            } as EImageDerivativeBackend;
          }
        }

        return await this.imageFilesService.addDerivative(
          imageId,
          converted_key,
          convertResult.filetype,
          convertResult.image,
        );
      },
    );
  }

  // File getters ==============================================================

  public async getMaster(imageId: string): AsyncFailable<EImageFileBackend> {
    // SVG masters are stored verbatim: tell the caller not to hand them to
    // sharp, which cannot read them as a raster source. Callers that need the
    // bytes regardless use `getMasterFile()`.
    const filetype = await this.getMasterFileType(imageId);
    if (HasFailed(filetype)) return filetype;

    if (filetype.identifier === ImageFileType.SVG) {
      return Fail(
        FT.UsrValidation,
        'Unsupported conversion',
        'SVG images have no raster master file',
      );
    }

    return this.imageFilesService.getFile(imageId, ImageEntryVariant.MASTER);
  }

  /** Returns the master file as stored, including SVG masters. */
  public async getMasterFile(
    imageId: string,
  ): AsyncFailable<EImageFileBackend> {
    return this.imageFilesService.getFile(imageId, ImageEntryVariant.MASTER);
  }

  public async getMasterFileType(imageId: string): AsyncFailable<FileType> {
    const mime = await this.imageFilesService.getFileTypes(imageId);
    if (HasFailed(mime)) return mime;

    if (mime['master'] === undefined)
      return Fail(FT.NotFound, 'No master file');

    return ParseFileType(mime['master']);
  }

  /**
   * File type plus byte size of the master, read without pulling the file.
   *
   * HEAD responses need `Content-Length`, and a video master can be 128 MB:
   * loading it only to measure it would exhaust memory on every probe.
   */
  public async getMasterFileInfo(
    imageId: string,
  ): AsyncFailable<{ filetype: string; size: number }> {
    return this.imageFilesService.getFileInfo(imageId, ImageEntryVariant.MASTER);
  }

  public async getOriginal(imageId: string): AsyncFailable<EImageFileBackend> {
    return this.imageFilesService.getFile(imageId, ImageEntryVariant.ORIGINAL);
  }

  public async getOriginalFileType(imageId: string): AsyncFailable<FileType> {
    const filetypes = await this.imageFilesService.getFileTypes(imageId);
    if (HasFailed(filetypes)) return filetypes;

    if (filetypes['original'] === undefined)
      return Fail(FT.NotFound, 'No original file');

    return ParseFileType(filetypes['original']);
  }

  public async getFileMimes(imageId: string): AsyncFailable<{
    [ImageEntryVariant.MASTER]: string;
    [ImageEntryVariant.ORIGINAL]: string | undefined;
  }> {
    const result = await this.imageFilesService.getFileTypes(imageId);
    if (HasFailed(result)) return result;

    if (result[ImageEntryVariant.MASTER] === undefined) {
      return Fail(FT.NotFound, 'No master file found');
    }

    return {
      [ImageEntryVariant.MASTER]: result[ImageEntryVariant.MASTER],
      [ImageEntryVariant.ORIGINAL]: result[ImageEntryVariant.ORIGINAL],
    };
  }

  // Util stuff ==================================================================

  private async getFileTypeFromBuffer(image: Buffer): AsyncFailable<FileType> {
    const filetypeResult: FileTypeResult | undefined =
      await fileTypeFromBuffer(image);

    let mime: string | undefined;
    if (filetypeResult === undefined) {
      if (IsQOI(image)) mime = 'image/x-qoi';
      // file-type does not detect SVG: it has no binary signature.
      else if (isSvg(image.toString('utf8'))) mime = 'image/svg+xml';
    } else {
      mime = filetypeResult.mime;
      // XML-based SVG is reported as generic XML by file-type.
      if (
        (mime === 'application/xml' || mime === 'text/xml') &&
        isSvg(image.toString('utf8'))
      ) {
        mime = 'image/svg+xml';
      }
    }

    if (mime === undefined) {
      // Not an image we can identify (random bytes, truncated file, empty
      // file): that is a bad upload, not a server error (audit A-6). Falling
      // through to Mime2FileType('other/unknown') produced a 500.
      return Fail(
        FT.UsrValidation,
        'Unsupported or unrecognized image format',
      );
    }

    let filetype: string | undefined;
    if (mime === 'image/webp') {
      const header = await WebPInfo.from(image);
      if (header.summary.isAnimated) filetype = AnimFileType.WEBP;
      else filetype = ImageFileType.WEBP;
    }
    if (filetype === undefined) {
      const parsed = Mime2FileType(mime);
      // Recognised container (mov, mkv, pdf with an image-ish stream, ...) that
      // this instance does not accept: that is the uploader's problem, so it
      // must surface as a 400, not as the internal 500 this used to be.
      if (HasFailed(parsed)) {
        return Fail(
          FT.UsrValidation,
          `Unsupported upload format: ${mime}`,
          parsed.getReason(),
        );
      }
      filetype = parsed;
    }

    return ParseFileType(filetype);
  }

  private getConvertHash(options: object) {
    // Return a sha256 hash of the stringified options
    const stringified = JSON.stringify(options);
    const hash = createHash('sha256');
    hash.update(stringified);
    const digest = hash.digest('hex');
    return digest;
  }
}
