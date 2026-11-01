import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { I18nService } from '../../i18n/i18n.service';
import { ImageMetaResponse } from 'picsur-shared/dist/dto/api/image.dto';
import { ImageLinks } from 'picsur-shared/dist/dto/image-links.class';
import {
  AnimFileType,
  FileType2Ext,
  FileType2Mime,
  ImageFileType,
  IsPlayableVideoFiletype,
  SupportedFileTypeCategory,
} from 'picsur-shared/dist/dto/mimes.dto';

import { EImage } from 'picsur-shared/dist/entities/image.entity';
import { EUser } from 'picsur-shared/dist/entities/user.entity';

import { HasFailed } from 'picsur-shared/dist/types/failable';
import { UUIDRegex } from 'picsur-shared/dist/util/common-regex';
import {
  IsVideoFiletypeIdentifier,
  ParseFileType,
} from 'picsur-shared/dist/util/parse-mime';
import { Subscription, timer } from 'rxjs';
import { ImageService } from '../../services/api/image.service';
import { Logger } from '../../services/logger/logger.service';
import { ErrorService } from '../../util/error-manager/error.service';
import { UtilService } from '../../util/util.service';

@Component({
  standalone: false,
  templateUrl: './view.component.html',
  styleUrls: ['./view.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewComponent implements OnInit, OnDestroy {
  private readonly logger = new Logger(ViewComponent.name);

  private expires_timeout: Subscription | null = null;
  private language_subscription: Subscription | null = null;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly imageService: ImageService,
    private readonly errorService: ErrorService,
    private readonly utilService: UtilService,
    private readonly changeDetector: ChangeDetectorRef,
    private readonly i18n: I18nService,
  ) {}

  private id = '';
  public metadata: ImageMetaResponse | null = null;
  public set OnMetadata(metadata: ImageMetaResponse) {
    this.metadata = metadata;
    // The route component can be reused for another id; player state of the
    // previous video must not leak into the next one.
    this.updateVideoPlayability();
    this.subscribeTimeout(metadata.image.expires_at);

    this.changeDetector.markForCheck();
  }

  public formatOptions: {
    value: string;
    key: string;
  }[] = [];

  public selectedFormat: string = ImageFileType.JPEG;

  /**
   * The browser refused to play the video element.
   *
   * mp4/webm are native formats, so this is unusual for them; it is the normal
   * outcome for the optional containers (mov, mkv, ...) whose codecs may not be
   * supported. The page then shows the direct link / download panel instead of
   * an empty black box.
   */
  public videoPlaybackFailed = false;

  /**
   * Whether this browser can play the stored container at all.
   *
   * mp4 and webm are native everywhere, so the shared whitelist answers without
   * a probe. Every other accepted container is stored and served as-is - the
   * page must ask the browser via `canPlayType`; mp4 inside an mkv, QuickTime
   * in Chrome and similar combinations legitimately come back with an empty
   * answer. "probably" and "maybe" render the player, and a decode error still
   * falls back to the panel because canPlayType is only a hint.
   */
  public videoPlayable = false;

  public onVideoError(): void {
    this.videoPlaybackFailed = true;
    this.changeDetector.markForCheck();
  }

  private updateVideoPlayability(): void {
    this.videoPlaybackFailed = false;
    this.videoPlayable = false;

    if (!this.isVideo || this.metadata === null) return;

    const filetype = this.metadata.fileTypes.master;
    if (IsPlayableVideoFiletype(filetype)) {
      this.videoPlayable = true;
      return;
    }

    const mime = FileType2Mime(filetype);
    if (HasFailed(mime)) return;

    const probe = document.createElement('video');
    const support = probe.canPlayType(String(mime));
    this.videoPlayable = support === 'probably' || support === 'maybe';
  }

  public get image(): EImage | null {
    return this.metadata?.image ?? null;
  }

  public get user(): EUser | null {
    return this.metadata?.user ?? null;
  }

  public get hasOriginal(): boolean {
    if (this.metadata === null) return false;
    // An SVG upload is stored as the master file, but it is still the user's
    // original artwork, so it has to be offered in the format list.
    return (
      this.metadata.fileTypes.original !== undefined ||
      this.metadata.fileTypes.master === ImageFileType.SVG
    );
  }

  /**
   * Is this upload a video?
   *
   * A video is stored verbatim and cannot be previewed as a picture or
   * transcoded, so every image oriented part of the page (preview, format
   * dropdown, customize) has to branch on this. Detected from the stored
   * filetype only - no extra column, the shared helper owns the prefix test.
   */
  public get isVideo(): boolean {
    if (this.metadata === null) return false;
    return (
      IsVideoFiletypeIdentifier(this.metadata.fileTypes.master) ||
      IsVideoFiletypeIdentifier(this.metadata.image.source_filetype)
    );
  }

  /** Direct link to the video, always with its own extension. */
  public get videoLink(): string {
    if (this.metadata === null) return '';
    return this.imageService.GetImageURL(
      this.id,
      this.metadata.fileTypes.master,
    );
  }

  /**
   * File name offered to the browser when downloading the video.
   *
   * The upload stripped the extension from `file_name`, so it has to be added
   * back: a download without `.<ext>` is not recognised by the OS.
   */
  public get videoDownloadName(): string {
    const baseName =
      this.image?.file_name ?? this.i18n.instant('view.imageFallbackName');

    if (this.metadata === null) return baseName;

    const ext = FileType2Ext(this.metadata.fileTypes.master);
    return HasFailed(ext) ? baseName : `${baseName}.${ext}`;
  }

  public get previewLink(): string {
    if (this.metadata === null) return '';

    // There is no picture to show for a video: the template swaps in the
    // placeholder and the direct link instead of pulling the file into an
    // image element that cannot decode it.
    if (this.isVideo) return this.videoLink;

    // Get width of screen in pixels
    const width = window.innerWidth * window.devicePixelRatio;

    // Browsers can render SVG, but going through a raster format keeps the
    // preview consistent with how the image is displayed everywhere else.
    const previewFiletype =
      this.metadata.fileTypes.master === ImageFileType.SVG
        ? ImageFileType.JPEG
        : this.metadata.fileTypes.master;

    return (
      this.imageService.GetImageURL(this.id, previewFiletype) +
      (width > 1 ? `?width=${width}&shrinkonly=yes` : '')
    );
  }

  private imageLinksCache: Record<string, ImageLinks> = {};
  public get imageLinks(): ImageLinks {
    const kind = this.isVideo ? 'video' : 'image';
    const format = this.selectedFormat;
    const cacheKey = `${kind}:${format}`;

    if (this.imageLinksCache[cacheKey] !== undefined)
      return this.imageLinksCache[cacheKey];

    const links = this.imageService.CreateImageLinksFromID(
      this.id,
      this.getImageLinkFiletype(format),
      this.image?.file_name,
      kind,
    );

    this.imageLinksCache[cacheKey] = links;
    return links;
  }

  async ngOnInit() {
    // The format dropdown stores display strings, one of which ("original") is
    // translated, so it has to be rebuilt when the language changes.
    this.language_subscription = this.i18n.languageChange.subscribe(() => {
      this.updateFormatOptions();
      this.changeDetector.markForCheck();
    });

    // Extract and verify params
    {
      const params = this.route.snapshot.paramMap;

      this.id = params.get('id') ?? '';
      if (!UUIDRegex.test(this.id)) {
        return this.errorService.quitError(
          this.i18n.instant('images.invalidLink'),
          this.logger,
        );
      }
    }

    // Get metadata
    {
      const metadata = await this.imageService.GetImageMeta(this.id);
      if (HasFailed(metadata))
        return this.errorService.quitFailure(metadata, this.logger);

      if (metadata.image.expires_at !== null) {
        if (metadata.image.expires_at <= new Date())
          return this.errorService.quitWarn(
            this.i18n.instant('images.notFound'),
            this.logger,
          );

        this.subscribeTimeout(metadata.image.expires_at);
      }

      this.metadata = metadata;
      this.updateVideoPlayability();
    }

    // Populate default selected format
    {
      // A video keeps its own container. Letting the image default (JPEG) win
      // would make every copy field point at /i/<id>.jpg, which the backend
      // correctly rejects as a cross-media conversion.
      if (this.isVideo) {
        this.selectedFormat = this.metadata.fileTypes.master;
      } else if (this.metadata.image.source_filetype === ImageFileType.PNG) {
        // Uploads keep their original filetype in the default selection when
        // that filetype is PNG: the stored master is always QOI, so without
        // this an uploaded PNG would be shown as JPEG.
        this.selectedFormat = ImageFileType.PNG;
      } else {
        let masterFiletype = ParseFileType(this.metadata.fileTypes.master);
        if (HasFailed(masterFiletype)) {
          masterFiletype = {
            identifier: ImageFileType.JPEG,
            category: SupportedFileTypeCategory.Image,
          };
        }

        switch (masterFiletype.category) {
          case SupportedFileTypeCategory.Image:
            this.selectedFormat = ImageFileType.JPEG;
            break;
          case SupportedFileTypeCategory.Animation:
            this.selectedFormat = AnimFileType.GIF;
            break;
          default:
            this.selectedFormat = this.metadata.fileTypes.master;
            break;
        }
      }
    }

    this.updateFormatOptions();
    this.changeDetector.markForCheck();
  }

  ngOnDestroy() {
    if (this.expires_timeout !== null) this.expires_timeout.unsubscribe();
    if (this.language_subscription !== null)
      this.language_subscription.unsubscribe();
  }

  goBackHome() {
    this.router.navigate(['/']);
  }

  private updateFormatOptions() {
    // Videos have no format list: the master is served as-is and any other
    // format would be a 400. The template hides the dropdown on this branch.
    if (this.isVideo) {
      this.formatOptions = [];
      return;
    }

    let newOptions: {
      value: string;
      key: string;
    }[] = [];

    if (this.hasOriginal) {
      newOptions.push({
        value: this.getOriginalFormatLabel(),
        key: 'original',
      });
    }

    newOptions = newOptions.concat(this.utilService.getBaseFormatOptions());

    this.formatOptions = newOptions;
  }

  private getImageLinkFiletype(format: string): string | null {
    // Video links must carry the video's own extension (mp4/webm). Without
    // this the "original" selection would resolve to a link without extension
    // and the image formats to a cross-media 400.
    if (this.isVideo) {
      return this.metadata?.fileTypes.master ?? null;
    }

    if (format !== 'original') return format;
    if (this.metadata === null) return null;

    const originalFiletype =
      this.metadata.fileTypes.original ?? this.metadata.fileTypes.master;

    // "original" without an extension resolves to the placeholder image, so an
    // SVG master has to be linked with its extension explicitly.
    return originalFiletype === ImageFileType.SVG ? ImageFileType.SVG : null;
  }

  private getOriginalFormatLabel(): string {
    if (this.metadata === null) return this.i18n.instant('view.original');

    const originalFiletype =
      this.metadata.fileTypes.original ?? this.metadata.fileTypes.master;

    return originalFiletype === ImageFileType.SVG
      ? 'SVG'
      : this.i18n.instant('view.original');
  }

  private subscribeTimeout(expires_at: Date | null) {
    if (this.expires_timeout !== null) this.expires_timeout.unsubscribe();

    if (expires_at === null) return;

    this.expires_timeout = timer(expires_at).subscribe(() => {
      this.errorService.quitWarn(
        this.i18n.instant('images.expired'),
        this.logger,
      );
    });
  }
}
