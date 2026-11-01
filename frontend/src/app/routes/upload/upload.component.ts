import { Component, HostListener, OnInit } from '@angular/core';
import { FormControl } from '@angular/forms';
import { Router } from '@angular/router';
import { FileInputValue } from '@ngx-dropzone/cdk';
import { AutoUnsubscribe } from 'ngx-auto-unsubscribe-decorator';
import {
  FileType2Ext,
  FileType2Mime,
  SupportedFileTypes,
} from 'picsur-shared/dist/dto/mimes.dto';
import { Permission } from 'picsur-shared/dist/dto/permissions.enum';
import { Fail, FT, HasFailed } from 'picsur-shared/dist/types/failable';
import {
  ParseExt2FileType,
  ParseMime2FileType,
} from 'picsur-shared/dist/util/parse-mime';
import { debounceTime } from 'rxjs';
import { ProcessingViewMeta } from '../../models/dto/processing-view-meta.dto';
import { PermissionService } from '../../services/api/permission.service';
import { Logger } from '../../services/logger/logger.service';
import { ErrorService } from '../../util/error-manager/error.service';

@Component({
  standalone: false,
  templateUrl: './upload.component.html',
  styleUrls: ['./upload.component.scss'],
})
export class UploadComponent implements OnInit {
  private readonly logger = new Logger(UploadComponent.name);

  canUpload = true;

  fileControl = new FormControl<FileInputValue>(null);

  /**
   * `accept` is generated from the shared whitelist: a hardcoded string in the
   * template would silently drift the moment a format is added or removed.
   *
   * Mime entries alone are not enough for the video containers without a
   * registered platform mime (`video/matroska`, `video/vnd.avi`,
   * `video/x-ms-asf`): file pickers match `accept` against the OS mime table,
   * which often reports the vendor variant or nothing at all. Listing the
   * extension as well keeps `mov`, `mkv`, `wmv`, ... selectable.
   */
  public acceptedMimeTypes = '';

  constructor(
    private readonly router: Router,
    private readonly permissionService: PermissionService,
    private readonly errorService: ErrorService,
  ) {}

  ngOnInit(): void {
    this.onPermission();
    this.onFileChange();
    this.buildAcceptedMimeTypes();
  }

  private buildAcceptedMimeTypes(): void {
    const accepted = new Set<string>();
    for (const filetype of SupportedFileTypes) {
      const mime = FileType2Mime(filetype);
      if (!HasFailed(mime)) accepted.add(mime);

      const ext = FileType2Ext(filetype);
      if (!HasFailed(ext)) accepted.add(`.${ext}`);
    }

    this.acceptedMimeTypes = [...accepted].join(',');
  }

  /**
   * Client side pre-check so a file the shared tables do not know (a PDF, a
   * zip, a container outside the whitelist) is rejected before it travels to
   * the server.
   *
   * `accept` only filters the file picker: drag & drop and clipboard paste
   * bypass it, so both entry points have to validate themselves. The check goes
   * through the shared mime/ext tables rather than the browser-reported mime,
   * because browsers use their own names for several containers
   * (`video/x-matroska` vs the file-type `video/matroska`) and the extension
   * fallback is what keeps those uploads working.
   */
  private isSupportedMedia(file: File): boolean {
    if (!HasFailed(ParseMime2FileType(file.type ?? ''))) return true;

    const dot = file.name.lastIndexOf('.');
    if (dot === -1) return false;

    const ext = file.name.substring(dot + 1).toLowerCase();
    return !HasFailed(ParseExt2FileType(ext));
  }

  @AutoUnsubscribe()
  onFileChange() {
    return this.fileControl.valueChanges.subscribe((file) => {
      if (!file) return;
      let files = Array.isArray(file) ? file : [file];
      files = files.filter((f) => this.isSupportedMedia(f));

      if (files.length === 0)
        return this.errorService.info('upload.unsupportedType');

      const metadata: ProcessingViewMeta = new ProcessingViewMeta(files);
      this.router.navigate(['/processing'], { state: metadata });
    });
  }

  @AutoUnsubscribe()
  onPermission() {
    return this.permissionService.live
      .pipe(debounceTime(100))
      .subscribe((permissions) => {
        this.canUpload = permissions.includes(Permission.ImageUpload);
      });
  }

  @HostListener('document:paste', ['$event'])
  onPaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items;
    if (!items) return this.errorService.info('upload.clipboardEmpty');

    const filteredItems = Array.from(items).filter(
      (item) => item.kind === 'file',
    );

    if (filteredItems.length === 0)
      return this.errorService.info('upload.clipboardNoImages');

    const blobs = filteredItems.map((item) => item.getAsFile());
    if (blobs.some((blob) => blob === null))
      return this.errorService.showFailure(
        Fail(FT.Internal, 'upload.clipboardImageError'),
        this.logger,
      );

    const safeBlob = blobs as File[];

    // Paste is one of the paths that bypass `accept`, so validate here too.
    const supported = safeBlob.filter((blob) => this.isSupportedMedia(blob));
    if (supported.length === 0)
      return this.errorService.info('upload.unsupportedType');

    const metadata: ProcessingViewMeta = new ProcessingViewMeta(supported);

    this.router.navigate(['/processing'], { state: metadata });
  }
}
