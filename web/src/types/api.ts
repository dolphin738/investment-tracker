/* eslint-disable */
// Generated from docs/openapi.json (OpenAPI 3.1).
// Produced by a deterministic converter mirroring openapi-typescript's
// `components['schemas']` output. Drop-in compatible if the CLI is run later.
export interface paths { [name: string]: unknown }
export interface components {
  schemas: {
    /** AccountStatsOut */
    AccountStatsOut: {
        /** Portfoliocount */
        portfolioCount: number;
        /** Totalassets */
        totalAssets: string;
        /** Cumulativexirr */
        cumulativeXirr?: string | unknown;
        /** Yearxirr */
        yearXirr?: string | unknown;
      };
    /** AuthTokenOut */
    AuthTokenOut: {
        /** Accesstoken */
        accessToken: string;
        user: components['schemas']['UserPublicOut'];
      };
    /** Body_import_preview_api_portfolios__portfolio_id__import_preview_post */
    Body_import_preview_api_portfolios__portfolio_id__import_preview_post: {
        /** Type */
        type: string;
        /** File */
        file: string;
      };
    /** Body_upload_avatar_api_upload_avatar_post */
    Body_upload_avatar_api_upload_avatar_post: {
        /** File */
        file?: string | unknown;
      };
    /** CashBalanceCreateReq */
    CashBalanceCreateReq: {
        /** Amount */
        amount: string;
        /** Asof */
        asOf: string;
        /** Note */
        note?: string | unknown;
      };
    /** CashBalanceOut */
    CashBalanceOut: {
        /** Id */
        id: string;
        /** Amount */
        amount: string;
        /** Asof */
        asOf: string;
        /** Note */
        note?: string | unknown;
        /** Createdat */
        createdAt: string;
      };
    /** CashBalancePatchReq */
    CashBalancePatchReq: {
        /** Amount */
        amount?: string | unknown;
        /** Note */
        note?: string | unknown;
      };
    /** CashflowCreateReq */
    CashflowCreateReq: {
        /** Date */
        date: string;
        /** Type */
        type: string;
        /** Amount */
        amount: string;
        /** Note */
        note?: string | unknown;
      };
    /** CashflowOut */
    CashflowOut: {
        /** Id */
        id: string;
        /** Date */
        date: string;
        /** Type */
        type: string;
        /** Amount */
        amount: string;
        /** Note */
        note?: string | unknown;
        /** Createdat */
        createdAt: string;
      };
    /** CashflowPatchReq */
    CashflowPatchReq: {
        /** Date */
        date?: unknown;
        /** Type */
        type?: string | unknown;
        /** Amount */
        amount?: string | unknown;
        /** Note */
        note?: string | unknown;
      };
    /** ClearDataOut */
    ClearDataOut: {
        /** Deletedcount */
        deletedCount: Record<string, number>;
      };
    /** DividendCreateReq */
    DividendCreateReq: {
        /** Securityid */
        securityId: string;
        /** Date */
        date: string;
        /** Amount */
        amount: string;
        /** Tax */
        tax?: string | unknown;
        /** Type */
        type?: string | unknown;
        /** Note */
        note?: string | unknown;
      };
    /** DividendOut */
    DividendOut: {
        /** Id */
        id: string;
        /** Securityid */
        securityId: string;
        /** Securitycode */
        securityCode?: string | unknown;
        /** Securityname */
        securityName?: string | unknown;
        /** Date */
        date: string;
        /** Amount */
        amount: string;
        /** Tax */
        tax: string;
        /** Netamount */
        netAmount: string;
        /** Type */
        type: string;
        /** Note */
        note?: string | unknown;
        /** Createdat */
        createdAt: string;
      };
    /** DividendPatchReq */
    DividendPatchReq: {
        /** Securityid */
        securityId?: string | unknown;
        /** Date */
        date?: unknown;
        /** Amount */
        amount?: string | unknown;
        /** Tax */
        tax?: string | unknown;
        /** Type */
        type?: string | unknown;
        /** Note */
        note?: string | unknown;
      };
    /** DrawdownPointOut */
    DrawdownPointOut: {
        /** Date */
        date: string;
        /** Drawdown */
        drawdown?: string | unknown;
        /** Peakdate */
        peakDate?: string | unknown;
        /** Label */
        label: string;
      };
    /** EmailPatchReq */
    EmailPatchReq: {
        /** Currentpassword */
        currentPassword: string;
        /** Newemail */
        newEmail: string;
      };
    /** FreshnessOut */
    FreshnessOut: {
        /** Staledays */
        staleDays: number;
        /** Isstale */
        isStale: boolean;
        /** Latestpriceasof */
        latestPriceAsOf?: string | unknown;
        /** Latestpricelagdays */
        latestPriceLagDays?: number | unknown;
        /** Latestcashasof */
        latestCashAsOf?: string | unknown;
        /** Latestcashlagdays */
        latestCashLagDays?: number | unknown;
        /** Reasons */
        reasons?: string[];
      };
    /** HTTPValidationError */
    HTTPValidationError: {
        /** Detail */
        detail?: components['schemas']['ValidationError'][];
      };
    /** HoldingOut */
    HoldingOut: {
        /** Securityid */
        securityId: string;
        /** Code */
        code?: string | unknown;
        /** Name */
        name?: string | unknown;
        /** Quantity */
        quantity: string;
        /** Avgcost */
        avgCost: string;
        /** Costtotal */
        costTotal: string;
        /** Price */
        price: string;
        /** Marketvalue */
        marketValue: string;
        /** Pnl */
        pnl: string;
        /** Ratio */
        ratio: string;
        /** Iscostbased */
        isCostBased: boolean;
      };
    /** ImportCommitOut */
    ImportCommitOut: {
        /** Inserted */
        inserted: number;
        /** Updated */
        updated: number;
        /** Skipped */
        skipped: number;
        /** Failed */
        failed?: Record<string, unknown>[];
        /** Recalculated */
        recalculated?: Record<string, unknown> | unknown;
      };
    /** ImportCommitReq */
    ImportCommitReq: {
        /** Type */
        type: string;
        /** Token */
        token: string;
      };
    /** ImportPreviewOut */
    ImportPreviewOut: {
        /** Type */
        type: string;
        /** Totalrows */
        totalRows: number;
        /** Validrows */
        validRows: number;
        /** Sample */
        sample?: Record<string, unknown>[];
        /** Errors */
        errors?: Record<string, unknown>[];
        /** Mindate */
        minDate?: string | unknown;
        /** Token */
        token: string;
      };
    /** LoginReq */
    LoginReq: {
        /** Email */
        email: string;
        /** Password */
        password: string;
      };
    /** NAV 序列点（兼容 metric=both 的 {cumulativeNav,yearNav} 与 单值 {value}）。 */
    NavPointOut: {
        /** Date */
        date: string;
        /** Value */
        value?: string | unknown;
        /** Cumulativenav */
        cumulativeNav?: string | unknown;
        /** Yearnav */
        yearNav?: string | unknown;
        /** Shares */
        shares?: string | unknown;
      };
    /** OverviewOut */
    OverviewOut: {
        /** Totalasset */
        totalAsset?: string | unknown;
        /** Cumulativexirr */
        cumulativeXirr?: string | unknown;
        /** Yearxirr */
        yearXirr?: string | unknown;
        /** Navseries */
        navSeries?: components['schemas']['NavPointOut'][];
        /** Recentcashflows */
        recentCashflows?: components['schemas']['CashflowOut'][];
        freshness: components['schemas']['FreshnessOut'];
      };
    /** Paginated[CashBalanceOut] */
    Paginated_CashBalanceOut_: {
        /** Items */
        items: components['schemas']['CashBalanceOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** Paginated[CashflowOut] */
    Paginated_CashflowOut_: {
        /** Items */
        items: components['schemas']['CashflowOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** Paginated[DividendOut] */
    Paginated_DividendOut_: {
        /** Items */
        items: components['schemas']['DividendOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** Paginated[NavPointOut] */
    Paginated_NavPointOut_: {
        /** Items */
        items: components['schemas']['NavPointOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** Paginated[PriceOut] */
    Paginated_PriceOut_: {
        /** Items */
        items: components['schemas']['PriceOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** Paginated[SecurityOut] */
    Paginated_SecurityOut_: {
        /** Items */
        items: components['schemas']['SecurityOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** Paginated[SnapshotOut] */
    Paginated_SnapshotOut_: {
        /** Items */
        items: components['schemas']['SnapshotOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** Paginated[TradeOut] */
    Paginated_TradeOut_: {
        /** Items */
        items: components['schemas']['TradeOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** Paginated[XirrPointOut] */
    Paginated_XirrPointOut_: {
        /** Items */
        items: components['schemas']['XirrPointOut'][];
        /** Total */
        total: number;
        /** Page */
        page: number;
        /** Pagesize */
        pageSize: number;
      };
    /** PasswordPatchReq */
    PasswordPatchReq: {
        /** Currentpassword */
        currentPassword: string;
        /** Newpassword */
        newPassword: string;
      };
    /** 归档请求：archived 缺省或 true → 归档；false → 取消归档。 */
    PortfolioArchiveReq: {
        /** Archived */
        archived?: boolean | unknown;
      };
    /** PortfolioCreateReq */
    PortfolioCreateReq: {
        /** Name */
        name: string;
        /** Description */
        description?: string | unknown;
        /** Currency */
        currency?: string;
      };
    /** PortfolioOut */
    PortfolioOut: {
        /** Id */
        id: string;
        /** Name */
        name: string;
        /** Description */
        description?: string | unknown;
        /** Basedate */
        baseDate: string;
        /** Currency */
        currency: string;
        /** Archivedat */
        archivedAt?: string | unknown;
        /** Createdat */
        createdAt: string;
        /** Updatedat */
        updatedAt: string;
      };
    /** PortfolioPatchReq */
    PortfolioPatchReq: {
        /** Name */
        name?: string | unknown;
        /** Description */
        description?: string | unknown;
      };
    /** PortfolioSummaryOut */
    PortfolioSummaryOut: {
        /** Cumulativexirr */
        cumulativeXirr?: string | unknown;
        /** Totalreturnrate */
        totalReturnRate?: string | unknown;
        /** Yearreturnrate */
        yearReturnRate?: string | unknown;
        /** Maxdrawdown */
        maxDrawdown?: string | unknown;
        /** Latestdate */
        latestDate?: string | unknown;
        /** Inceptiondate */
        inceptionDate: string;
      };
    /** PreferenceOut */
    PreferenceOut: {
        /** Id */
        id: string;
        /** Defaultportfolioid */
        defaultPortfolioId?: string | unknown;
        /** Defaultgranularity */
        defaultGranularity: string;
        /** Defaultdaterange */
        defaultDateRange: string;
        /** Aggregation */
        aggregation: string;
        /** Weekstartson */
        weekStartsOn: number;
        /** Navdecimals */
        navDecimals: number;
        /** Xirrdecimals */
        xirrDecimals: number;
        /** Theme */
        theme: string;
        /** Staledays */
        staleDays: number;
        /** Showliquidated */
        showLiquidated: boolean;
        /** Costbasisview */
        costBasisView: string;
        /** Cashhintoncashflow */
        cashHintOnCashflow: boolean;
        /** Cashhintontrade */
        cashHintOnTrade: boolean;
        /** Amountthousands */
        amountThousands: boolean;
        /** Amountabbrev */
        amountAbbrev: boolean;
        /** Dashboardlayout */
        dashboardLayout: string;
      };
    /** PriceCreateReq */
    PriceCreateReq: {
        /** Securityid */
        securityId: string;
        /** Price */
        price: string;
        /** Asof */
        asOf: string;
      };
    /** PriceOut */
    PriceOut: {
        /** Id */
        id: string;
        /** Securityid */
        securityId: string;
        /** Price */
        price: string;
        /** Asof */
        asOf: string;
        /** Createdat */
        createdAt: string;
      };
    /** PricePatchReq */
    PricePatchReq: {
        /** Price */
        price?: string | unknown;
        /** Asof */
        asOf?: string | unknown;
      };
    /** ProfilePatchReq */
    ProfilePatchReq: {
        /** Name */
        name?: string | unknown;
        /** Avatar */
        avatar?: string | unknown;
      };
    /** RecalcOut */
    RecalcOut: {
        /** Affecteddates */
        affectedDates: number;
        /** Duration */
        duration: number;
      };
    /** RecalculateRangeReq */
    RecalculateRangeReq: {
        /** Startdate */
        startDate?: string | unknown;
        /** Enddate */
        endDate?: string | unknown;
      };
    /** RegisterReq */
    RegisterReq: {
        /** Email */
        email: string;
        /** Password */
        password: string;
        /** Name */
        name?: string | unknown;
      };
    /** RestoreReq */
    RestoreReq: {
        /** Email */
        email: string;
        /** Password */
        password: string;
      };
    /** SecurityCreateReq */
    SecurityCreateReq: {
        /** Code */
        code: string;
        /** Name */
        name: string;
        /** Type */
        type?: string | unknown;
        /** Currency */
        currency?: string;
      };
    /** SecurityOut */
    SecurityOut: {
        /** Id */
        id: string;
        /** Code */
        code: string;
        /** Name */
        name: string;
        /** Type */
        type: string;
        /** Currency */
        currency: string;
        /** Createdat */
        createdAt: string;
      };
    /** SecurityPatchReq */
    SecurityPatchReq: {
        /** Name */
        name?: string | unknown;
        /** Type */
        type?: string | unknown;
      };
    /** SnapshotCreateReq */
    SnapshotCreateReq: {
        /** Date */
        date: string;
        /** Totalasset */
        totalAsset: string;
        /** Marketvalue */
        marketValue?: string | unknown;
        /** Cashbalance */
        cashBalance?: string | unknown;
        /** Note */
        note?: string | unknown;
      };
    /** SnapshotOut */
    SnapshotOut: {
        /** Id */
        id: string;
        /** Date */
        date: string;
        /** Totalasset */
        totalAsset?: string | unknown;
        /** Marketvalue */
        marketValue?: string | unknown;
        /** Cashbalance */
        cashBalance?: string | unknown;
        /** Source */
        source: string;
        /** Valuationflag */
        valuationFlag: string;
        /** Note */
        note?: string | unknown;
        /** Recordedat */
        recordedAt: string;
        /** Derivedtotalasset */
        derivedTotalAsset?: string | unknown;
      };
    /** SnapshotPatchReq */
    SnapshotPatchReq: {
        /** Totalasset */
        totalAsset?: string | unknown;
        /** Marketvalue */
        marketValue?: string | unknown;
        /** Cashbalance */
        cashBalance?: string | unknown;
        /** Note */
        note?: string | unknown;
      };
    /** TradeCreateReq */
    TradeCreateReq: {
        /** Date */
        date: string;
        /** Securityid */
        securityId: string;
        /** Side */
        side: string;
        /** Quantity */
        quantity: string;
        /** Price */
        price: string;
        /** Fee */
        fee?: string | unknown;
        /** Note */
        note?: string | unknown;
      };
    /** TradeOut */
    TradeOut: {
        /** Id */
        id: string;
        /** Securityid */
        securityId: string;
        /** Date */
        date: string;
        /** Side */
        side: string;
        /** Quantity */
        quantity: string;
        /** Price */
        price: string;
        /** Fee */
        fee: string;
        /** Note */
        note?: string | unknown;
        /** Createdat */
        createdAt: string;
      };
    /** TradePatchReq */
    TradePatchReq: {
        /** Date */
        date?: unknown;
        /** Quantity */
        quantity?: string | unknown;
        /** Price */
        price?: string | unknown;
        /** Fee */
        fee?: string | unknown;
      };
    /** UserPublicOut */
    UserPublicOut: {
        /** Id */
        id: string;
        /** Email */
        email: string;
        /** Name */
        name: string;
        /** Avatar */
        avatar?: string | unknown;
      };
    /** ValidationError */
    ValidationError: {
        /** Location */
        loc: string | number[];
        /** Message */
        msg: string;
        /** Error Type */
        type: string;
        /** Input */
        input?: unknown;
        /** Context */
        ctx?: Record<string, unknown>;
      };
    /** XirrLatestOut */
    XirrLatestOut: {
        /** Date */
        date: string;
        /** Xirrvalue */
        xirrValue?: string | unknown;
      };
    /** XirrPointOut */
    XirrPointOut: {
        /** Date */
        date: string;
        /** Value */
        value?: string | unknown;
      };
  };
}

/** operationId -> response schema name (HTTP 200, application/json). */
export interface operations {
    register_api_auth_register_post: components['schemas']['UserPublicOut'];
    login_api_auth_login_post: components['schemas']['AuthTokenOut'];
    restore_api_auth_account_restore_post: components['schemas']['AuthTokenOut'];
    me_api_auth_me_get: components['schemas']['UserPublicOut'];
    profile_api_auth_profile_patch: components['schemas']['UserPublicOut'];
    change_password_api_auth_password_patch: components['schemas']['AuthTokenOut'];
    change_email_api_auth_email_patch: components['schemas']['AuthTokenOut'];
    summary_api_portfolios__portfolio_id__summary_get: components['schemas']['PortfolioSummaryOut'];
    overview_api_portfolios__portfolio_id__overview_get: components['schemas']['OverviewOut'];
    account_stats_api_account_stats_get: components['schemas']['AccountStatsOut'];
    create_portfolio_api_portfolios_post: components['schemas']['PortfolioOut'];
    get_portfolio_detail_api_portfolios__portfolio_id__get: components['schemas']['PortfolioOut'];
    patch_portfolio_api_portfolios__portfolio_id__patch: components['schemas']['PortfolioOut'];
    clear_data_api_portfolios__portfolio_id__data_delete: components['schemas']['ClearDataOut'];
    archive_portfolio_api_portfolios__portfolio_id__archive_patch: components['schemas']['PortfolioOut'];
    list_cashflows_api_portfolios__portfolio_id__cashflows_get: components['schemas']['Paginated_CashflowOut_'];
    create_cashflow_api_portfolios__portfolio_id__cashflows_post: components['schemas']['CashflowOut'];
    get_cashflow_api_portfolios__portfolio_id__cashflows__cf_id__get: components['schemas']['CashflowOut'];
    patch_cashflow_api_portfolios__portfolio_id__cashflows__cf_id__patch: components['schemas']['CashflowOut'];
    list_securities_api_portfolios__portfolio_id__securities_get: components['schemas']['Paginated_SecurityOut_'];
    create_security_api_portfolios__portfolio_id__securities_post: components['schemas']['SecurityOut'];
    get_security_api_portfolios__portfolio_id__securities__sec_id__get: components['schemas']['SecurityOut'];
    patch_security_api_portfolios__portfolio_id__securities__sec_id__patch: components['schemas']['SecurityOut'];
    list_trades_api_portfolios__portfolio_id__security_trades_get: components['schemas']['Paginated_TradeOut_'];
    create_trade_api_portfolios__portfolio_id__security_trades_post: components['schemas']['TradeOut'];
    get_trade_api_portfolios__portfolio_id__security_trades__trade_id__get: components['schemas']['TradeOut'];
    patch_trade_api_portfolios__portfolio_id__security_trades__trade_id__patch: components['schemas']['TradeOut'];
    list_prices_api_portfolios__portfolio_id__security_prices_get: components['schemas']['Paginated_PriceOut_'];
    create_price_api_portfolios__portfolio_id__security_prices_post: components['schemas']['PriceOut'];
    patch_price_api_portfolios__portfolio_id__security_prices__price_id__patch: components['schemas']['PriceOut'];
    list_cashbalances_api_portfolios__portfolio_id__cash_balances_get: components['schemas']['Paginated_CashBalanceOut_'];
    create_cashbalance_api_portfolios__portfolio_id__cash_balances_post: components['schemas']['CashBalanceOut'];
    patch_cashbalance_api_portfolios__portfolio_id__cash_balances__cb_id__patch: components['schemas']['CashBalanceOut'];
    list_snapshots_api_portfolios__portfolio_id__snapshots_get: components['schemas']['Paginated_SnapshotOut_'];
    create_snapshot_api_portfolios__portfolio_id__snapshots_post: components['schemas']['SnapshotOut'];
    get_snapshot_by_date_api_portfolios__portfolio_id__snapshots__snap_date__get: components['schemas']['SnapshotOut'];
    patch_snapshot_api_portfolios__portfolio_id__snapshots__snap_id__patch: components['schemas']['SnapshotOut'];
    reset_snapshot_api_portfolios__portfolio_id__snapshots__snap_date__reset_post: components['schemas']['SnapshotOut'];
    list_dividends_api_portfolios__portfolio_id__dividends_get: components['schemas']['Paginated_DividendOut_'];
    create_dividend_api_portfolios__portfolio_id__dividends_post: components['schemas']['DividendOut'];
    patch_dividend_api_portfolios__portfolio_id__dividends__div_id__patch: components['schemas']['DividendOut'];
    import_preview_api_portfolios__portfolio_id__import_preview_post: components['schemas']['ImportPreviewOut'];
    import_commit_api_portfolios__portfolio_id__import_commit_post: components['schemas']['ImportCommitOut'];
    get_preferences_api_users_preferences_get: components['schemas']['PreferenceOut'];
    patch_preferences_api_users_preferences_patch: components['schemas']['PreferenceOut'];
    get_xirr_latest_api_portfolios__portfolio_id__xirr_latest_get: components['schemas']['XirrLatestOut'];
    get_xirr_history_api_portfolios__portfolio_id__xirr_history_get: components['schemas']['Paginated_XirrPointOut_'];
    get_nav_latest_api_portfolios__portfolio_id__nav_latest_get: components['schemas']['NavPointOut'];
    get_nav_history_api_portfolios__portfolio_id__nav_history_get: components['schemas']['Paginated_NavPointOut_'];
    recalculate_range_api_portfolios__portfolio_id__recalculate_range_post: components['schemas']['RecalcOut'];
    recalculate_full_api_portfolios__portfolio_id__recalculate_post: components['schemas']['RecalcOut'];
  };
