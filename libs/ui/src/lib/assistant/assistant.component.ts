import { GfAssetProfileIconComponent } from '@ghostfolio/client/components/asset-profile-icon/asset-profile-icon.component';
import { AdminService } from '@ghostfolio/client/services/admin.service';
import { DataService } from '@ghostfolio/client/services/data.service';
import { Filter, User } from '@ghostfolio/common/interfaces';
import { DateRange } from '@ghostfolio/common/types';
import { translate } from '@ghostfolio/ui/i18n';

import { FocusKeyManager } from '@angular/cdk/a11y';
import { CommonModule } from '@angular/common';
import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  QueryList,
  ViewChild,
  ViewChildren
} from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormsModule,
  ReactiveFormsModule
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatMenuTrigger } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { RouterModule } from '@angular/router';
import { Account, AssetClass } from '@prisma/client';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { EMPTY, Observable, Subject, lastValueFrom } from 'rxjs';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  map,
  mergeMap,
  takeUntil
} from 'rxjs/operators';

import { GfAssistantListItemComponent } from './assistant-list-item/assistant-list-item.component';
import {
  IDateRangeOption,
  ISearchResultItem,
  ISearchResults
} from './interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    GfAssetProfileIconComponent,
    GfAssistantListItemComponent,
    MatButtonModule,
    MatFormFieldModule,
    MatSelectModule,
    NgxSkeletonLoaderModule,
    ReactiveFormsModule,
    RouterModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-assistant',
  standalone: true,
  styleUrls: ['./assistant.scss'],
  templateUrl: './assistant.html'
})
export class GfAssistantComponent implements OnChanges, OnDestroy, OnInit {
  @HostListener('document:keydown', ['$event']) onKeydown(
    event: KeyboardEvent
  ) {
    if (!this.isOpen) {
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      for (const item of this.assistantListItems) {
        item.removeFocus();
      }

      this.keyManager.onKeydown(event);

      const currentAssistantListItem = this.getCurrentAssistantListItem();

      if (currentAssistantListItem?.linkElement) {
        currentAssistantListItem.linkElement.nativeElement?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }
    } else if (event.key === 'Enter') {
      const currentAssistantListItem = this.getCurrentAssistantListItem();

      if (currentAssistantListItem?.linkElement) {
        currentAssistantListItem.linkElement.nativeElement?.click();
        event.stopPropagation();
      }
    }
  }

  @Input() deviceType: string;
  @Input() hasPermissionToAccessAdminControl: boolean;
  @Input() hasPermissionToChangeDateRange: boolean;
  @Input() hasPermissionToChangeFilters: boolean;
  @Input() user: User;

  @Output() closed = new EventEmitter<void>();
  @Output() dateRangeChanged = new EventEmitter<DateRange>();
  @Output() filtersChanged = new EventEmitter<Filter[]>();

  @ViewChild('menuTrigger') menuTriggerElement: MatMenuTrigger;
  @ViewChild('search', { static: true }) searchElement: ElementRef;

  @ViewChildren(GfAssistantListItemComponent)
  assistantListItems: QueryList<GfAssistantListItemComponent>;

  public static readonly SEARCH_RESULTS_DEFAULT_LIMIT = 5;

  public accounts: Account[] = [];
  public assetClasses: Filter[] = [];
  public dateRangeFormControl = new FormControl<string>(undefined);
  public dateRangeOptions: IDateRangeOption[] = [];
  public filterForm = this.formBuilder.group({
    account: new FormControl<string>(undefined),
    assetClass: new FormControl<string>(undefined),
    tag: new FormControl<string>(undefined),
    holding: new FormControl<string>(undefined)  // Added FormControl for holding
  });
  public isLoading = false;
  public isOpen = false;
  public placeholder = $localize`Find holding...`;
  public searchFormControl = new FormControl('');
  public searchResults: ISearchResults = {
    assetProfiles: [],
    holdings: []
  };
  public tags: Filter[] = [];
  public holdings: ISearchResultItem[] = [];  // Added property to store fetched holdings

  private filterTypes: Filter['type'][] = ['ACCOUNT', 'ASSET_CLASS', 'TAG', 'HOLDING'];  // Added holding to filter types
  private keyManager: FocusKeyManager<GfAssistantListItemComponent>;
  private unsubscribeSubject = new Subject<void>();

  public constructor(
    private adminService: AdminService,
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private formBuilder: FormBuilder
  ) {}

  public ngOnInit() {
    this.assetClasses = Object.keys(AssetClass).map((assetClass) => {
      return {
        id: assetClass,
        label: translate(assetClass),
        type: 'ASSET_CLASS'
      };
    });

    // Fetch holdings when component initializes
    this.dataService
      .fetchPortfolioHoldings({ range: 'max' })
      .pipe(takeUntil(this.unsubscribeSubject))
      .subscribe(({ holdings }) => {
        this.holdings = holdings.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        this.changeDetectorRef.markForCheck();
      });

    this.searchFormControl.valueChanges
      .pipe(
        map((searchTerm) => {
          this.isLoading = true;
          this.searchResults = {
            assetProfiles: [],
            holdings: []
          };

          this.changeDetectorRef.markForCheck();

          return searchTerm;
        }),
        debounceTime(300),
        distinctUntilChanged(),
        mergeMap(async (searchTerm) => {
          const result = <ISearchResults>{
            assetProfiles: [],
            holdings: []
          };

          try {
            if (searchTerm) {
              return await this.getSearchResults(searchTerm);
            }
          } catch {}

          return result;
        }),
        takeUntil(this.unsubscribeSubject)
      )
      .subscribe((searchResults) => {
        this.searchResults = searchResults;
        this.isLoading = false;

        this.changeDetectorRef.markForCheck();
      });
  }

  public ngOnChanges() {
    this.accounts = this.user?.accounts ?? [];

    this.dateRangeOptions = [
      { label: $localize`Today`, value: '1d' },
      { label: `${$localize`Week to date`} (${$localize`WTD`})`, value: 'wtd' },
      { label: `${$localize`Month to date`} (${$localize`MTD`})`, value: 'mtd' },
      { label: `${$localize`Year to date`} (${$localize`YTD`})`, value: 'ytd' },
      { label: `1 ${$localize`year`} (${$localize`1Y`})`, value: '1y' }
    ];

    this.dateRangeOptions = this.dateRangeOptions.concat([
      { label: `5 ${$localize`years`} (${$localize`5Y`})`, value: '5y' },
      { label: $localize`Max`, value: 'max' }
    ]);

    this.dateRangeFormControl.disable({ emitEvent: false });

    if (this.hasPermissionToChangeDateRange) {
      this.dateRangeFormControl.enable({ emitEvent: false });
    }

    this.dateRangeFormControl.setValue(this.user?.settings?.dateRange ?? null);

    this.filterForm.disable({ emitEvent: false });

    if (this.hasPermissionToChangeFilters) {
      this.filterForm.enable({ emitEvent: false });
    }

    this.filterForm.setValue(
      {
        account: this.user?.settings?.['filters.accounts']?.[0] ?? null,
        assetClass: this.user?.settings?.['filters.assetClasses']?.[0] ?? null,
        tag: this.user?.settings?.['filters.tags']?.[0] ?? null,
        holding: null  // Reset holding value initially
      },
      {
        emitEvent: false
      }
    );

    this.tags = this.user?.tags
      ?.filter(({ isUsed }) => isUsed)
      .map(({ id, name }) => ({
        id,
        label: translate(name),
        type: 'TAG'
      })) ?? [];

    if (this.tags.length === 0) {
      this.filterForm.get('tag').disable({ emitEvent: false });
    }
  }

  public onApplyFilters() {
    this.filtersChanged.emit([
      {
        id: this.filterForm.get('account').value,
        type: 'ACCOUNT'
      },
      {
        id: this.filterForm.get('assetClass').value,
        type: 'ASSET_CLASS'
      },
      {
        id: this.filterForm.get('tag').value,
        type: 'TAG'
      },
      {
        id: this.filterForm.get('holding').value,  // Emit holding filter
        type: 'SYMBOL'
      }
    ]);

    this.onCloseAssistant();
  }

  public onCloseAssistant() {
    this.closed.emit();
  }

  private getCurrentAssistantListItem() {
    const currentAssistantListItem = this.keyManager.activeItem;

    if (!currentAssistantListItem) {
      this.keyManager.setFirstItemActive();
    }

    return this.keyManager.activeItem;
  }

  private async getSearchResults(searchTerm: string): Promise<ISearchResults> {
    const adminObservable = this.hasPermissionToAccessAdminControl
      ? this.adminService.fetchSearchResults(searchTerm)
      : EMPTY;

    const dataServiceObservable = this.dataService.fetchSearchResults(
      searchTerm
    );

    return lastValueFrom(
      adminObservable.pipe(
        catchError(() => EMPTY),
        mergeMap(() => dataServiceObservable)
      )
    );
  }

  public ngOnDestroy() {
    this.unsubscribeSubject.next();
    this.unsubscribeSubject.complete();
  }
}
