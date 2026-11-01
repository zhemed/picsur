import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService } from '../../../i18n/i18n.service';

import { AutoUnsubscribe } from 'ngx-auto-unsubscribe-decorator';
import { ImageMetaResponse } from 'picsur-shared/dist/dto/api/image.dto';
import { ImageFileType } from 'picsur-shared/dist/dto/mimes.dto';
import { Permission } from 'picsur-shared/dist/dto/permissions.enum';
import { EImage } from 'picsur-shared/dist/entities/image.entity';
import { EUser } from 'picsur-shared/dist/entities/user.entity';
import { HasFailed } from 'picsur-shared/dist/types/failable';
import { IsVideoFiletypeIdentifier } from 'picsur-shared/dist/util/parse-mime';
import { ImageService } from '../../../services/api/image.service';
import { PermissionService } from '../../../services/api/permission.service';
import { UserService } from '../../../services/api/user.service';
import { Logger } from '../../../services/logger/logger.service';
import { DialogService } from '../../../util/dialog-manager/dialog.service';
import { DownloadService } from '../../../util/download-manager/download.service';
import { ErrorService } from '../../../util/error-manager/error.service';
import { UtilService } from '../../../util/util.service';
import {
  CustomizeDialogComponent,
  CustomizeDialogData,
} from '../customize-dialog/customize-dialog.component';
import {
  EditDialogComponent,
  EditDialogData,
} from '../edit-dialog/edit-dialog.component';

@Component({
  standalone: false,
  selector: 'view-speeddial',
  templateUrl: './view-speeddial.component.html',
  styleUrls: ['./view-speeddial.component.scss'],
})
export class ViewSpeeddialComponent implements OnInit {
  private readonly logger = new Logger(ViewSpeeddialComponent.name);

  public canManage = false;

  @Input() public metadata: ImageMetaResponse | null = null;
  @Output() public metadataChange = new EventEmitter<ImageMetaResponse>();

  @Input() public selectedFormat: string = ImageFileType.JPEG;

  public get image(): EImage | null {
    return this.metadata?.image ?? null;
  }

  public get user(): EUser | null {
    return this.metadata?.user ?? null;
  }

  /** Videos cannot be customized in this tier; see `customize()`. */
  public get isVideo(): boolean {
    if (this.metadata === null) return false;
    return (
      IsVideoFiletypeIdentifier(this.metadata.fileTypes.master) ||
      IsVideoFiletypeIdentifier(this.metadata.image.source_filetype)
    );
  }

  constructor(
    private readonly permissionService: PermissionService,
    private readonly downloadService: DownloadService,
    private readonly errorService: ErrorService,
    private readonly dialogService: DialogService,
    private readonly imageService: ImageService,
    private readonly utilService: UtilService,
    private readonly userService: UserService,
    private readonly router: Router,
    private readonly i18n: I18nService,
  ) {}

  ngOnInit(): void {
    this.subscribePermissions();
  }

  @AutoUnsubscribe()
  private subscribePermissions() {
    this.updatePermissions(this.permissionService.snapshot);
    return this.permissionService.live.subscribe(
      this.updatePermissions.bind(this),
    );
  }

  private updatePermissions(permissions: string[]) {
    if (permissions.includes(Permission.ImageAdmin)) {
      this.canManage = true;
      return;
    }

    if (this.user === null) return;

    if (
      permissions.includes(Permission.ImageManage) &&
      this.user.id === this.userService.snapshot?.id
    ) {
      this.canManage = true;
      return;
    }

    this.canManage = false;
  }

  download() {
    if (this.image === null) return;

    this.downloadService.downloadFile(
      this.imageService.GetImageURL(this.image?.id, this.selectedFormat),
      this.image.file_name,
    );
  }

  share() {
    if (this.image === null) return;

    this.downloadService.shareFile(
      this.imageService.GetImageURL(this.image?.id, this.selectedFormat),
    );
  }

  async deleteImage() {
    if (this.image === null) return;

    const pressedButton = await this.dialogService.showDialog({
      title: this.i18n.instant('images.deleteConfirmTitle'),
      description: this.i18n.instant('common.actionCannotBeUndone'),
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
      const result = await this.imageService.DeleteImage(this.image.id);
      if (HasFailed(result))
        return this.errorService.showFailure(result, this.logger);

      this.errorService.success(this.i18n.instant('images.deleted'));

      this.router.navigate(['/']);
    }
  }

  async customize() {
    if (this.image === null) return;

    // Guarding here as well as in the template: the speed dial can be opened by
    // keyboard or a stale DOM, and a video has no conversion options at all.
    if (this.isVideo) return;

    const options: CustomizeDialogData = {
      imageID: this.image.id,
      selectedFormat: this.selectedFormat,
      formatOptions: this.utilService.getBaseFormatOptions(),
    };

    if (options.selectedFormat === 'original') {
      options.selectedFormat = ImageFileType.JPEG;
    }

    await this.dialogService.showCustomDialog(
      CustomizeDialogComponent,
      options,
    );
  }

  async editImage() {
    if (this.image === null) return;

    const options: EditDialogData = {
      image: { ...this.image },
    };

    const res: EImage | null = await this.dialogService.showCustomDialog(
      EditDialogComponent,
      options,
    );

    if (res && this.metadata !== null) {
      this.metadataChange.emit({ ...this.metadata, image: res });
    }
  }
}
