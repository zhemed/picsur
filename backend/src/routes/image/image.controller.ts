import {
  Controller,
  Get,
  Head,
  Headers,
  Logger,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ImageMetaResponse,
  ImageRequestParams,
} from 'picsur-shared/dist/dto/api/image.dto';
import { ImageEntryVariant } from 'picsur-shared/dist/dto/image-entry-variant.enum';
import { FileType2Mime, ImageFileType } from 'picsur-shared/dist/dto/mimes.dto';
import {
  Fail,
  FT,
  IsFailure,
  ThrowIfFailed,
} from 'picsur-shared/dist/types/failable';
import { IsVideoFiletypeIdentifier } from 'picsur-shared/dist/util/parse-mime';
import { UserDbService } from '../../collections/user-db/user-db.service.js';
import { EasyThrottle } from '../../decorators/easy-throttle.decorator.js';
import { ImageFullIdParam } from '../../decorators/image-id/image-full-id.decorator.js';
import { ImageIdParam } from '../../decorators/image-id/image-id.decorator.js';
import { RequiredPermissions } from '../../decorators/permissions.decorator.js';
import { Returns } from '../../decorators/returns.decorator.js';
import { ImageManagerService } from '../../managers/image/image.service.js';
import type { ImageFullId } from '../../models/constants/image-full-id.const.js';
import { Permission } from '../../models/constants/permissions.const.js';
import { EUserBackend2EUser } from '../../models/transformers/user.transformer.js';
import { BrandMessageType, GetBrandMessage } from '../../util/branding.js';

// SVG is an active document format: it can carry scripts and load remote
// resources. Sans this, a browser that opens /i/<id>.svg directly would render
// it in this origin. The payload is already sanitized on upload; these headers
// are the second layer for anything that slips through.
const SvgContentSecurityPolicy = [
  'sandbox',
  "default-src 'none'",
  "base-uri 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
].join('; ');

// Request budget for the public image routes. They used to be `@SkipThrottle()`
// (= unlimited) while every request can spawn a sharp worker and store a new
// derivative, so one anonymous caller could drive unbounded CPU and database
// growth (audit A-8). The limit is deliberately loose: a gallery page pulls
// dozens of thumbnails at once, and clients behind one NAT share a bucket.
const ImageRequestsPerMinute = 600;

/**
 * Outcome of parsing a single `Range: bytes=...` request.
 *
 * `none` means "serve the whole file" - either there was no Range header, or it
 * asked for multiple ranges, which this endpoint deliberately answers with the
 * full body instead of a multipart/byteranges reply.
 */
type ByteRange =
  | { kind: 'none' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

// This is the only controller with CORS enabled
@Controller('i')
@RequiredPermissions(Permission.ImageView)
@EasyThrottle(ImageRequestsPerMinute, 60)
export class ImageController {
  private readonly logger = new Logger(ImageController.name);

  constructor(
    private readonly imagesService: ImageManagerService,
    private readonly userService: UserDbService,
  ) {}

  @Head(':id')
  async headImage(
    @Res({ passthrough: true }) res: FastifyReply,
    @ImageFullIdParam() fullid: ImageFullId,
  ) {
    try {
      if (fullid.variant === ImageEntryVariant.ORIGINAL) {
        const filetype = ThrowIfFailed(
          await this.getOriginalDownloadFileType(fullid.id),
        );

        if (IsVideoFiletypeIdentifier(filetype.identifier)) {
          await this.sendVideoHead(res, fullid.id);
          return;
        }

        this.setImageResponseHeaders(res, filetype.identifier);
        res.type(ThrowIfFailed(FileType2Mime(filetype.identifier)));
        return;
      }

      // A video only exists in the container it was uploaded as: asking for a
      // different extension is a bad request, exactly like GET answers it.
      if (IsVideoFiletypeIdentifier(fullid.filetype)) {
        const info = ThrowIfFailed(
          await this.imagesService.getMasterFileInfo(fullid.id),
        );

        if (info.filetype !== fullid.filetype) {
          throw Fail(
            FT.UsrValidation,
            'Unsupported conversion',
            'Video formats cannot be converted',
          );
        }

        this.setImageResponseHeaders(res, info.filetype);
        res.type(ThrowIfFailed(FileType2Mime(info.filetype)));
        res.header('Accept-Ranges', 'bytes');
        res.header('Content-Length', String(info.size));
        return;
      }

      // The requested filetype is already known from the URL, so existence has
      // to be checked separately: HEAD is the probe used by the image
      // component, and a deleted image must not answer 200 (see `getImage`).
      const masterFiletype = ThrowIfFailed(
        await this.imagesService.getMasterFileType(fullid.id),
      );

      // A video master cannot answer an image extension: GET rejects the same
      // request, so HEAD must not answer 200 for it either.
      if (IsVideoFiletypeIdentifier(masterFiletype.identifier)) {
        throw Fail(
          FT.UsrValidation,
          'Unsupported conversion',
          'Videos can only be served in their own format',
        );
      }

      this.setImageResponseHeaders(res, fullid.filetype);
      res.type(ThrowIfFailed(FileType2Mime(fullid.filetype)));
    } catch (e) {
      // Clients use HEAD to probe whether an image still exists, so a missing
      // image must not be reported as 200 (see `getImage`).
      if (!IsFailure(e) || e.getType() !== FT.NotFound) throw e;

      this.setNotFoundHeaders(res);
    }
  }

  @Get(':id')
  async getImage(
    // Usually passthrough is for manually sending the response,
    // But we need it here to set the mime type
    @Res({ passthrough: true }) res: FastifyReply,
    @ImageFullIdParam() fullid: ImageFullId,
    @Query() params: ImageRequestParams,
    @Headers('range') range?: string,
  ): Promise<Buffer> {
    try {
      if (fullid.variant === ImageEntryVariant.ORIGINAL) {
        const filetype = ThrowIfFailed(
          await this.getOriginalDownloadFileType(fullid.id),
        );

        // A video has no separate original, so the extension-less URL falls
        // back to the master. It is answered by the range-capable path because
        // a player may use exactly this URL and needs to be able to seek.
        if (IsVideoFiletypeIdentifier(filetype.identifier)) {
          const info = ThrowIfFailed(
            await this.imagesService.getMasterFileInfo(fullid.id),
          );
          return this.sendVideo(res, fullid.id, info, range);
        }

        const image = ThrowIfFailed(await this.getOriginalDownload(fullid.id));

        this.setImageResponseHeaders(res, image.filetype);
        res.type(ThrowIfFailed(FileType2Mime(image.filetype)));
        return image.data;
      }

      // Videos are served from their master verbatim and with Range support;
      // they never go through the converter (there is no video transcoding).
      if (IsVideoFiletypeIdentifier(fullid.filetype)) {
        const info = ThrowIfFailed(
          await this.imagesService.getMasterFileInfo(fullid.id),
        );

        if (info.filetype !== fullid.filetype) {
          throw Fail(
            FT.UsrValidation,
            'Unsupported conversion',
            'Video formats cannot be converted',
          );
        }

        return this.sendVideo(res, fullid.id, info, range);
      }

      const image = ThrowIfFailed(
        await this.imagesService.getConverted(
          fullid.id,
          fullid.filetype,
          params,
        ),
      );

      this.setImageResponseHeaders(res, image.filetype);
      res.type(ThrowIfFailed(FileType2Mime(image.filetype)));
      return image.data;
    } catch (e) {
      if (!IsFailure(e) || e.getType() !== FT.NotFound) throw e;

      // A deleted (or never existing) image is a 404. The branded placeholder
      // is still returned as the body, so hotlinked links keep showing
      // something recognisable, but it must never be cached: with a 30 day
      // cache the browser would keep serving it for an id that is gone.
      this.setNotFoundHeaders(res);

      const message = ThrowIfFailed(
        await GetBrandMessage(BrandMessageType.NotFound),
      );
      res.type(message.type);
      return message.data;
    }
  }

  /**
   * Mark a missing image as 404 + no-store.
   *
   * The image cache middleware (`AppModule.imageCacheSet`) sets a month long
   * `Cache-Control` on every `/i/*` response, so it has to be overridden here.
   * Images that do exist keep that cache header untouched.
   */
  private setNotFoundHeaders(res: FastifyReply) {
    res.status(404);
    res.header('Cache-Control', 'no-store');
  }

  @Get('meta/:id')
  @Returns(ImageMetaResponse)
  async getImageMeta(
    @Res({ passthrough: true }) res: FastifyReply,
    @ImageIdParam() id: string,
  ): Promise<ImageMetaResponse> {
    // Metadata must not be cached: the frontend uses it to decide whether an
    // image still exists, so a cached 200 would keep rendering a deleted
    // image's page (with working looking links) for up to a month. The image
    // bytes themselves keep their long cache, only this JSON is exempt.
    res.header('Cache-Control', 'no-store');

    const image = ThrowIfFailed(await this.imagesService.findOne(id));

    const [fileMimesRes, imageUserRes] = await Promise.all([
      this.imagesService.getFileMimes(id),
      this.userService.findOne(image.user_id),
    ]);

    const fileTypes = ThrowIfFailed(fileMimesRes);
    const imageUser = ThrowIfFailed(imageUserRes);

    return { image, user: EUserBackend2EUser(imageUser), fileTypes };
  }

  private setImageResponseHeaders(res: FastifyReply, filetype: string) {
    // Videos are media, not documents: stop a browser from sniffing another
    // type out of the bytes. SVG keeps the stricter CSP block below.
    if (IsVideoFiletypeIdentifier(filetype)) {
      res.header('X-Content-Type-Options', 'nosniff');
      return;
    }

    if (filetype !== ImageFileType.SVG) return;

    res.header('Content-Security-Policy', SvgContentSecurityPolicy);
    res.header('X-Content-Type-Options', 'nosniff');
  }

  /**
   * HEAD for a video master: type and length come from the database, the video
   * itself is never read (a master can be 128 MB).
   */
  private async sendVideoHead(
    res: FastifyReply,
    imageId: string,
  ): Promise<void> {
    const info = ThrowIfFailed(
      await this.imagesService.getMasterFileInfo(imageId),
    );

    this.setImageResponseHeaders(res, info.filetype);
    res.type(ThrowIfFailed(FileType2Mime(info.filetype)));
    res.header('Accept-Ranges', 'bytes');
    res.header('Content-Length', String(info.size));
  }

  /**
   * Serves a video master, honouring a single HTTP byte range.
   *
   * Range support is what lets the browser seek instead of downloading the
   * whole file first, and Safari refuses to play a video without it. The bytes
   * live in a `bytea` column, not on disk, so the slice is cut inside Postgres
   * (`getMasterFileSlice`) instead of being loaded and then cut in Node.
   *
   * Multi-range requests are answered with the whole file on purpose: a
   * `multipart/byteranges` body is not worth the complexity for this endpoint.
   */
  private async sendVideo(
    res: FastifyReply,
    imageId: string,
    info: { filetype: string; size: number },
    rangeHeader: string | undefined,
  ): Promise<Buffer> {
    this.setImageResponseHeaders(res, info.filetype);
    res.type(ThrowIfFailed(FileType2Mime(info.filetype)));
    res.header('Accept-Ranges', 'bytes');

    const range = this.parseRangeHeader(rangeHeader, info.size);

    if (range.kind === 'unsatisfiable') {
      res.status(416);
      res.header('Content-Range', `bytes */${info.size}`);
      res.header('Content-Length', '0');
      // Errors are never cacheable (same invariant as the exception filter):
      // the /i/* middleware already set a month long Cache-Control before the
      // handler ran, so a 416 must explicitly opt out instead of being stored
      // by a shared cache for 30 days.
      res.header('Cache-Control', 'no-store');
      return Buffer.alloc(0);
    }

    if (range.kind === 'partial') {
      const slice = ThrowIfFailed(
        await this.imagesService.getMasterFileSlice(
          imageId,
          range.start,
          range.end - range.start + 1,
        ),
      );

      res.status(206);
      res.header(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${slice.size}`,
      );
      res.header('Content-Length', String(slice.data.length));
      return slice.data;
    }

    const file = ThrowIfFailed(await this.imagesService.getMasterFile(imageId));
    res.header('Content-Length', String(file.data.length));
    return file.data;
  }

  /**
   * Parse one `Range: bytes=...` request into a single satisfiable range.
   *
   * Supported forms: `bytes=start-end`, `bytes=start-` and `bytes=-suffix`.
   * Any other single range is treated as unsatisfiable (416) rather than
   * silently ignored, so a broken client gets a clear answer; a request with
   * several ranges is ignored and the whole file is served instead.
   */
  private parseRangeHeader(
    rangeHeader: string | undefined,
    size: number,
  ): ByteRange {
    if (rangeHeader === undefined) return { kind: 'none' };

    const trimmed = rangeHeader.trim();
    if (!trimmed.toLowerCase().startsWith('bytes=')) {
      return { kind: 'unsatisfiable' };
    }

    const specs = trimmed
      .substring('bytes='.length)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');

    if (specs.length > 1) return { kind: 'none' };
    if (specs.length === 0) return { kind: 'unsatisfiable' };

    const match = /^(\d*)-(\d*)$/.exec(specs[0]);
    if (match === null) return { kind: 'unsatisfiable' };

    const [, startText, endText] = match;
    if (startText === '' && endText === '') return { kind: 'unsatisfiable' };
    if (size <= 0) return { kind: 'unsatisfiable' };

    if (startText === '') {
      // bytes=-N: the last N bytes. A suffix longer than the file means the
      // whole file; a suffix of zero bytes cannot be satisfied.
      const suffixLength = Number(endText);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        return { kind: 'unsatisfiable' };
      }

      return {
        kind: 'partial',
        start: Math.max(0, size - suffixLength),
        end: size - 1,
      };
    }

    const start = Number(startText);
    if (!Number.isFinite(start) || start >= size) {
      return { kind: 'unsatisfiable' };
    }

    const requestedEnd = endText === '' ? size - 1 : Number(endText);
    if (!Number.isFinite(requestedEnd) || requestedEnd < start) {
      return { kind: 'unsatisfiable' };
    }

    return { kind: 'partial', start, end: Math.min(requestedEnd, size - 1) };
  }

  /**
   * Serves the uploaded original when it was kept, and falls back to the master
   * file for formats that are stored verbatim: SVG keeps the vector master, and
   * a video master *is* the original upload (no separate original is kept).
   * Without this fallback every `/i/<id>` for those uploads would return the
   * not-found placeholder.
   */
  private async getOriginalDownload(imageId: string) {
    const original = await this.imagesService.getOriginal(imageId);
    if (!IsFailure(original) || original.getType() !== FT.NotFound) {
      return original;
    }

    const master = await this.imagesService.getMasterFile(imageId);
    if (IsFailure(master)) return master;

    if (!this.isVerbatimMaster(master.filetype)) return original;

    return master;
  }

  private async getOriginalDownloadFileType(imageId: string) {
    const original = await this.imagesService.getOriginalFileType(imageId);
    if (!IsFailure(original) || original.getType() !== FT.NotFound) {
      return original;
    }

    const master = await this.imagesService.getMasterFileType(imageId);
    if (IsFailure(master)) return master;

    if (!this.isVerbatimMaster(master.identifier)) return original;

    return master;
  }

  /** Formats whose master file is also the user's original artwork. */
  private isVerbatimMaster(filetype: string): boolean {
    return (
      filetype === ImageFileType.SVG || IsVideoFiletypeIdentifier(filetype)
    );
  }
}
