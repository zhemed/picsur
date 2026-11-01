import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { I18nService } from '../../i18n/i18n.service';

import { Fail, FT, HasFailed } from 'picsur-shared/dist/types/failable';
import { Observable } from 'rxjs';
import { ApiService } from '../../services/api/api.service';
import { Logger } from '../../services/logger/logger.service';
import { DownloadDialogComponent } from '../dialog-manager/download-dialog/download-dialog.component';
import { ErrorService } from '../error-manager/error.service';
import { UtilService } from '../util.service';

@Injectable({
  providedIn: 'any',
})
export class DownloadService {
  private readonly logger = new Logger(DownloadService.name);

  constructor(
    private readonly dialog: MatDialog,
    private readonly api: ApiService,
    private readonly util: UtilService,
    private readonly errorService: ErrorService,
    private readonly i18n: I18nService,
  ) {}

  public showDownloadDialog(
    filename: string,
    progress?: Observable<number>,
  ): () => void {
    const ref = this.dialog.open(DownloadDialogComponent, {
      data: { name: filename, progress: progress },
      disableClose: true,
      closeOnNavigation: false,
    });

    return () => ref.close();
  }

  /**
   * Download a file through XHR (with a progress dialog).
   *
   * `fileName` is the name the user knows the file by (the title); the real
   * extension is derived from the served content type and appended when the
   * caller's name has none. Without this the saved file was always called
   * `image` or the bare UUID. Note that this buffers the whole file in memory:
   * for large videos prefer the same-origin direct link anchor on the view page.
   */
  public async downloadFile(url: string, fileName?: string) {
    const request = this.api.getBuffer(url);
    const closeDialog = this.showDownloadDialog(
      fileName ?? 'file',
      request.downloadProgress,
    );

    const file = await request.result;

    if (HasFailed(file)) {
      closeDialog();
      return this.errorService.showFailure(file, this.logger);
    }

    this.util.downloadBuffer(
      file.buffer,
      this.withExtension(fileName, file.name),
      file.mimeType,
    );

    closeDialog();

    this.errorService.info(this.i18n.instant('images.downloaded'));
  }

  /**
   * Combine the caller's name with the extension the server actually served
   * (`<id>.mp4`, `<id>.png`, ...). No name means "trust the served one".
   */
  private withExtension(fileName: string | undefined, servedName: string) {
    if (fileName === undefined) return servedName;

    const dot = servedName.lastIndexOf('.');
    const ext = dot === -1 ? '' : servedName.substring(dot);

    if (ext === '') return fileName;
    if (fileName.toLowerCase().endsWith(ext.toLowerCase())) return fileName;

    return fileName + ext;
  }

  public canShare(): boolean {
    if (navigator.canShare === undefined || navigator.share === undefined)
      return false;

    const testShare = navigator.canShare({
      url: 'https://www.example.com',
    });

    return testShare;
  }

  public canShareFiles(): boolean {
    if (!this.canShare()) return false;

    const testFile = new File([], 'test.txt');
    const testShare = navigator.canShare({
      files: [testFile],
    });

    return testShare;
  }

  public async shareFile(url: string) {
    if (!this.canShare())
      return this.errorService.warn(
        this.i18n.instant('download.shareUnsupported'),
        this.logger,
      );

    let shareObject: ShareData;

    if (!this.canShareFiles()) {
      shareObject = {
        url,
      };
    } else {
      const image = await this.api.getBuffer(url).result;
      if (HasFailed(image))
        return this.errorService.showFailure(image, this.logger);

      this.logger.log(image.name, image.mimeType);

      const imageFile = new File([image.buffer], image.name, {
        type: image.mimeType,
      });

      shareObject = {
        files: [imageFile],
      };
    }

    const canShare = navigator.canShare(shareObject);
    if (!canShare)
      return this.errorService.warn(
        this.i18n.instant('download.shareUnsupported'),
        this.logger,
      );

    try {
      await navigator.share(shareObject);
    } catch (e) {
      if (e instanceof DOMException && e.message === 'Share canceled') {
        // The user closed the share sheet, that is not an error worth a toast.
      } else {
        this.errorService.showFailure(
          Fail(FT.Internal, this.i18n.instant('download.shareFailed'), e),
          this.logger,
        );
      }
    }
  }
}
