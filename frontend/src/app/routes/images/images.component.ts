import {
  ChangeDetectorRef,
  Component,
  Inject,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { I18nService } from '../../i18n/i18n.service';

import { AutoUnsubscribe } from 'ngx-auto-unsubscribe-decorator';
import { ImageFileType } from 'picsur-shared/dist/dto/mimes.dto';
import { EImage } from 'picsur-shared/dist/entities/image.entity';
import { HasFailed } from 'picsur-shared/dist/types/failable';
import { IsVideoFiletypeIdentifier } from 'picsur-shared/dist/util/parse-mime';
import {
  BehaviorSubject,
  Observable,
  filter,
  map,
  merge,
  switchMap,
  timer,
} from 'rxjs';
import { WINDOW } from '@ng-web-apis/common';
import { ImageService } from '../../services/api/image.service';
import { UserService } from '../../services/api/user.service';
import { Logger } from '../../services/logger/logger.service';
import { BSScreenSize, BootstrapService } from '../../util/bootstrap.service';
import { DialogService } from '../../util/dialog-manager/dialog.service';
import { ErrorService } from '../../util/error-manager/error.service';

/**
 * How long the page may show "loading" before it admits something is wrong.
 *
 * The list request has no timeout of its own, and a request that never settles
 * (a stalled connection, a proxy that swallowed the answer) left the page on
 * its spinner forever — which the owner saw as "a blank page, only the header".
 * A readable failure with a retry button beats an endless spinner.
 */
const LOAD_TIMEOUT_MS = 10000;

@Component({
  standalone: false,
  templateUrl: './images.component.html',
  styleUrls: ['./images.component.scss'],
})
export class ImagesComponent implements OnInit, OnDestroy {
  private readonly logger: Logger = new Logger(ImagesComponent.name);

  imagesSub = new BehaviorSubject<EImage[] | null>(null);

  /**
   * The list request failed (server error, network, permissions).
   *
   * Without this the page kept `images === null`, which renders the loading
   * spinner forever: a failed request looked exactly like a blank page. The
   * owner hit this when the API answered 500 for every list request.
   */
  public loadFailed = false;

  /** Cleared when the list request settles; see LOAD_TIMEOUT_MS. */
  private loadTimer: ReturnType<typeof setTimeout> | undefined;

  /** Cards per row; kept in sync with the grid breakpoints in the SCSS. */
  columns = 1;

  /**
   * Pictures whose own size is smaller than the card's thumbnail box.
   *
   * Those must not be stretched to fill the box — that is upscaling and it is
   * what made the gallery look blurry. They are drawn at their own size.
   */
  smallThumbs = new Set<string>();

  /** CSS pixel width of one card, used to size the derivative request. */
  private cardWidth = 320;

  /**
   * Thumbnail URLs that were re-requested after the first decode showed they
   * were too small. Keyed by image id.
   */
  private thumbOverrides = new Map<string, string>();

  /** Width (in source pixels) each image was last requested at. */
  private thumbRequests = new Map<string, number>();

  public get images() {
    const value = this.imagesSub.value;
    return (
      value?.filter(
        (i) => i.expires_at === null || i.expires_at > new Date(),
      ) ?? null
    );
  }

  page = 1;
  pages = 1;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly bootstrapService: BootstrapService,
    private readonly userService: UserService,
    private readonly imageService: ImageService,
    private readonly errorService: ErrorService,
    private readonly dialogService: DialogService,
    private readonly i18n: I18nService,
    private readonly changeDetector: ChangeDetectorRef,
    @Inject(WINDOW) private readonly windowRef: Window,
  ) {}

  ngOnInit() {
    this.load().catch(this.logger.error);
    this.armLoadTimeout();
  }

  ngOnDestroy(): void {
    this.clearLoadTimeout();
  }

  private armLoadTimeout(): void {
    this.clearLoadTimeout();
    this.loadTimer = setTimeout(() => {
      if (this.images !== null || this.loadFailed) return;
      this.loadFailed = true;
      this.render();
      this.logger.error(
        `Image list did not answer within ${LOAD_TIMEOUT_MS}ms`,
      );
    }, LOAD_TIMEOUT_MS);
  }

  private clearLoadTimeout(): void {
    if (this.loadTimer === undefined) return;
    clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
  }

  private async load() {
    const params = this.route.snapshot.paramMap;

    let thispage = Number(params.get('page') ?? '');
    if (isNaN(thispage) || thispage <= 0) thispage = 1;
    this.page = thispage;

    this.subscribeMobile();
    this.subscribeUser();
    this.subscribeImages();
  }

  @AutoUnsubscribe()
  private subscribeMobile() {
    return this.bootstrapService.screenSize().subscribe((size) => {
      // Same breakpoints as `.gallery-grid` in the SCSS: 4 / 3 / 2 / 1.
      if (size <= BSScreenSize.sm) {
        this.columns = 1;
      } else if (size <= BSScreenSize.md) {
        this.columns = 2;
      } else if (size <= BSScreenSize.xl) {
        this.columns = 3;
      } else {
        this.columns = 4;
      }

      this.cardWidth = this.measureCardWidth();
    });
  }

  /**
   * Width of one card in CSS pixels, derived from the viewport and the grid
   * breakpoints (page padding 16px each side, 16px gaps).
   */
  private measureCardWidth(): number {
    const viewport = this.windowRef.innerWidth || 1024;
    const padding = 32;
    const gaps = (this.columns - 1) * 16;
    return Math.max(120, (viewport - padding - gaps) / this.columns);
  }

  @AutoUnsubscribe()
  private subscribeUser() {
    return this.userService.live.subscribe(async (user) => {
      if (user === null) return;

      await this.fetchImages();
    });
  }

  @AutoUnsubscribe()
  private subscribeImages() {
    // Make sure we only get populated images
    const filteredImagesSub: Observable<EImage[]> = this.imagesSub.pipe(
      filter((images) => images !== null),
    ) as Observable<EImage[]>;

    const mappedImagesSub: Observable<EImage> = filteredImagesSub.pipe(
      // Everytime we get a new array, we want merge a mapping of that array
      // In this mapping, each image will emit itself on the expire date
      switchMap((images: EImage[]) =>
        merge(
          ...images
            .filter((i) => i.expires_at !== null)
            .map((i) => timer(i.expires_at ?? new Date(0)).pipe(map(() => i))),
        ),
      ),
    ) as Observable<EImage>;

    return mappedImagesSub.subscribe((image) => {
      this.imagesSub.next(
        this.images?.filter((i) => i.id !== image.id) ?? null,
      );
    });
  }

  /**
   * Thumbnail URL that matches how big the picture is actually drawn.
   *
   * The old request asked for `height=480` no matter what the card showed, so
   * a portrait picture came back 240x480 and was then stretched over a 408px
   * wide box (1.7x upscaling — the blur the owner reported), while a wide
   * picture got a 1440px file for a 408px slot. Now the request is derived from
   * the card width times the screen density, with headroom for the crop that
   * `object-fit: cover` does, and `shrinkonly=yes` keeps the server from
   * inventing pixels the original does not have.
   *
   * When the list gave us the original's size, that headroom is not a guess any
   * more: the size the card draws at can be worked out up front, so the picture
   * never has to be measured and re-requested.
   */
  getThumbnailUrl(image: EImage) {
    const override = this.thumbOverrides.get(image.id);
    if (override !== undefined) return override;

    const { width: sourceWidth, height: sourceHeight } = image;
    const known =
      sourceWidth !== null &&
      sourceHeight !== null &&
      sourceWidth > 0 &&
      sourceHeight > 0;

    const width = known
      ? this.exactThumbWidth(sourceWidth, sourceHeight)
      : this.defaultThumbWidth();

    this.thumbRequests.set(image.id, width);
    return this.buildThumbUrl(image, width);
  }

  /**
   * Is this row a video?
   *
   * Videos have no thumbnail: the gallery must not ask the server for a WebP
   * derivative it cannot produce. The check looks at `source_filetype` only
   * (no schema change), every list row carries it, and the shared helper keeps
   * the string test in one place.
   */
  public isVideo(image: EImage): boolean {
    return IsVideoFiletypeIdentifier(image.source_filetype);
  }

  /** True when the API told us the original's pixel size. */
  private hasKnownSize(image: EImage): boolean {
    return (
      image.width !== null &&
      image.height !== null &&
      image.width > 0 &&
      image.height > 0
    );
  }

  /**
   * Should this thumbnail be drawn at its own size instead of filling the box?
   *
   * Pure on purpose (the template calls it): when the original's size is known
   * the answer is available before the picture even loads, which keeps a small
   * picture from flashing upscaled for one frame. Measured pictures land in
   * `smallThumbs` once they have loaded.
   */
  public isSmallThumb(image: EImage): boolean {
    if (this.smallThumbs.has(image.id)) return true;
    if (!this.hasKnownSize(image)) return false;

    const boxHeight = this.cardWidth * (3 / 4); // .gallery-thumb is 4:3
    return (
      (image.width ?? 0) < this.cardWidth || (image.height ?? 0) < boxHeight
    );
  }

  /**
   * Width in source pixels a card actually draws, derived from the original's
   * own size.
   *
   * `object-fit: cover` scales until the picture covers the box, so the drawn
   * width follows whichever ratio is larger, and the screen then needs that
   * many physical pixels. This is the same number `correctThumbSize` works out
   * after measuring - computing it here makes the first request the right one.
   *
   * The request is deliberately not clamped to the original's own width: when
   * the original is too small for the slot, asking for the honestly needed size
   * is what lets the server say "this is all there is" (`shrinkonly=yes` still
   * refuses to enlarge), and it is how the caller can tell a too-small original
   * apart from an undersized request.
   */
  private exactThumbWidth(sourceWidth: number, sourceHeight: number): number {
    const density = this.windowRef.devicePixelRatio || 1;
    const boxWidth = this.cardWidth;
    const boxHeight = this.cardWidth * (3 / 4); // .gallery-thumb is 4:3

    const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight);
    const needed = Math.ceil(sourceWidth * scale * density);

    return Math.min(2560, Math.max(160, needed));
  }

  /** Width in pixels the current thumbnail was requested at (for the probe). */
  public thumbRequestWidth(image: EImage): number | null {
    return this.thumbRequests.get(image.id) ?? null;
  }

  private defaultThumbWidth(): number {
    const density = this.windowRef.devicePixelRatio || 1;
    // 1.5x headroom: a 16:9 picture cropped into a 4:3 box is drawn 1.33x wider.
    const target = Math.round(this.cardWidth * density * 1.5);
    return Math.min(1600, Math.max(160, target));
  }

  /**
   * Thumbnail URL: WebP, sized, never bigger than the original.
   *
   * The gallery used to ask for QOI, which browsers cannot render: every
   * thumbnail then needed a HEAD request to learn the type, a fetch of the
   * bytes, a worker decode and a canvas paint. It was also 65x bigger than the
   * same picture as WebP (142 KB vs 2.2 KB for a 340px thumbnail), so a single
   * page pulled megabytes. WebP is rendered by the browser itself.
   */
  private buildThumbUrl(image: EImage, width: number): string {
    return (
      this.imageService.GetImageURL(image.id, ImageFileType.WEBP) +
      `?width=${width}&shrinkonly=yes`
    );
  }

  /**
   * Remembers pictures that are smaller than their box, so they are drawn 1:1
   * instead of being blown up.
   */
  onThumbLoaded(image: EImage, size: { width: number; height: number }) {
    const boxWidth = this.cardWidth;
    const boxHeight = this.cardWidth * (3 / 4); // .gallery-thumb is 4:3

    const fits = size.width >= boxWidth && size.height >= boxHeight;
    if (fits) {
      this.smallThumbs.delete(image.id);
    } else {
      this.smallThumbs.add(image.id);
    }

    // The request was already derived from the size the list gave us, so
    // measuring the decoded picture cannot turn up anything new. Correcting
    // here is precisely the second request this feature removes; when the size
    // is unknown the old measure-then-correct path still runs.
    if (this.hasKnownSize(image)) return;

    this.correctThumbSize(image, size, { width: boxWidth, height: boxHeight });
  }

  /**
   * Ask for a bigger derivative when the first one turns out too small.
   *
   * A fixed card box crops with `object-fit: cover`, so the drawn width is not
   * the box width: an ultra wide picture is drawn `aspect / (4/3)` times wider,
   * and on a 2x screen it needs twice the pixels again. The first request only
   * guesses, so once the real dimensions are known, re-request exactly what the
   * card shows (`shrinkonly=yes` still keeps the server from inventing pixels —
   * a small original simply stays 1:1 instead of being blown up).
   */
  private correctThumbSize(
    image: EImage,
    size: { width: number; height: number },
    box: { width: number; height: number },
  ) {
    const density = this.windowRef.devicePixelRatio || 1;
    const scale = Math.max(box.width / size.width, box.height / size.height);
    const needed = Math.ceil(size.width * scale * density);

    const requested = this.thumbRequests.get(image.id) ?? 0;
    if (needed <= size.width * 1.05) return; // the source is the limit, done
    if (needed <= requested) return; // already asked for enough

    const width = Math.min(2560, needed);
    this.thumbRequests.set(image.id, width);
    this.thumbOverrides.set(image.id, this.buildThumbUrl(image, width));
  }

  viewImage(image: EImage) {
    this.router.navigate(['/view', image.id]);
  }

  async deleteImage(image: EImage) {
    const pressedButton = await this.dialogService.showDialog({
      title: this.i18n.instant('images.deleteConfirmTitle'),
      description: this.i18n.instant('images.deleteConfirmDescription'),
      buttons: [
        {
          name: 'cancel',
          text: this.i18n.instant('common.actions.cancel'),
        },
        {
          color: 'warn',
          name: 'delete',
          text: this.i18n.instant('common.actions.delete'),
        },
      ],
    });

    if (pressedButton === 'delete') {
      const result = await this.imageService.DeleteImage(image.id ?? '');
      if (HasFailed(result))
        return this.errorService.showFailure(result, this.logger);

      this.errorService.success(this.i18n.instant('images.deleted'));
      this.imagesSub.next(
        this.images?.filter((i) => i.id !== image.id) ?? null,
      );
    }
  }

  /**
   * Try the list again, e.g. after the server recovered.
   *
   * Deliberately just the request, not `load()`: re-running the whole setup
   * would subscribe to the screen size and the user stream a second time, and
   * the user stream does not necessarily emit again on its own.
   */
  public retryLoad(): void {
    this.loadFailed = false;
    this.armLoadTimeout();
    this.fetchImages().catch(this.logger.error);
  }

  /** Fetch one page of the user's pictures and publish it. */
  private async fetchImages(): Promise<void> {
    const list = await this.imageService.ListMyImages(24, this.page - 1);
    this.clearLoadTimeout();
    if (HasFailed(list)) {
      this.loadFailed = true;
      this.render();
      return this.logger.error(list.getReason());
    }

    this.loadFailed = false;
    this.pages = list.pages;
    this.imagesSub.next(list.results);
    this.render();
  }

  /** Re-render after an async state change (the failure block appears at once). */
  private render(): void {
    this.changeDetector.detectChanges();
  }

  gotoPage(page: number) {
    this.router.navigate(['/images', page]).then(() => {
      this.load().catch(this.logger.error);
    });
  }
}
