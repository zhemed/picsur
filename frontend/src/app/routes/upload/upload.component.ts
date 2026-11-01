import { Component, HostListener, OnInit } from '@angular/core';
import { FormControl } from '@angular/forms';
import { Router } from '@angular/router';
import { FileInputValue } from '@ngx-dropzone/cdk';
import { AutoUnsubscribe } from 'ngx-auto-unsubscribe-decorator';
import {
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
    const mimes = new Set<string>();
    for (const filetype of SupportedFileTypes) {
      const mime = FileType2Mime(filetype);
      if (!HasFailed(mime)) mimes.add(mime);
    }

    this.acceptedMimeTypes = [...mimes].join(',');
  }

  /**
   * Client side pre-check so an unsupported container (mov, mkv, a PDF, ...)
   * is rejected before it travels to the server.
   *
   * `accept` only filters the file picker: drag & drop and clipboard paste
   * bypass it, so both entry points have to validate themselves. The check goes
   * through the shared mime/ext tables rather than `file.type.startsWith(...)`,
   * which would happily let `video/quicktime` through to a 400 from the server.
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
