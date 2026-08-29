/* eslint-disable */
// 后端 schema 类型字典（components['schemas']）。paths / operations 死壳已按 REP-051 删除，
// docs/openapi.json 同步废弃；本文件仅保留 components，供前端按 components['schemas']['XxxOut'] 取值。
export interface components {
  schemas: {
    /** AccountStatsOut */
    AccountStatsOut: {
        /** Portfoliocount */
        portfolioCount: number;
        /** Cashflowcount */
        cashflowCount: number;
        /** Tradecount */
        tradeCount: number;
        /** Snapshotdays */
        snapshotDays: number;
        /** Recorddays */
        recordDays: number;
        /** Firstdate */
        firstDate?: string | null;
        /** Lastdate */
        lastDate?: string | null;
      };
    /** AuthTokenOut */
    AuthTokenOut: {
        /** Accesstoken */
        accessToken: string;
        user: components['schemas']['UserPublicOut'];
      };
    /** Body_import_preview_api_portfolios__portfolio_id__import_preview_post */
    Body_import_preview_api_portfolios__portfolio_id__import_preview_post: {
        type: components['schemas']['ImportType'];
        /** File */
        file: string;
      };
    /** Body_upload_avatar_api_upload_avatar_post */
    Body_upload_avatar_api_upload_avatar_post: {
        /** File */
        file?: string | null;
      };
    /** CashBalanceCreateReq */
    CashBalanceCreateReq: {
        /** Amount */
        amount: string;
        /** Asof */
        asOf: string;
        /** Note */
        note?: string | null;
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
        note?: string | null;
        /** Createdat */
        createdAt: string;
        /** Updatedat */
        updatedAt: string;
      };
    /** CashBalancePatchReq */
    CashBalancePatchReq: {
        /** Amount */
        amount?: string | null;
        /** Note */
        note?: string | null;
      };
    /** CashFlowType */
    CashFlowType: 'BUY' | 'SELL';
    /** CashflowCreateReq */
    CashflowCreateReq: {
        /** Date */
        date: string;
        /** Type */
        type: string;
        /** Amount */
        amount: string;
        /** Note */
        note?: string | null;
      };
    /** CashflowOut */
    CashflowOut: {
        /** Id */
        id: string;
        /** Portfolioid */
        portfolioId: string;
        /** Date */
        date: string;
        type: components['schemas']['CashFlowType'];
        /** Amount */
        amount: string;
        /** Note */
        note?: string | null;
        /** Createdat */
        createdAt: string;
        /** Updatedat */
        updatedAt: string;
        recalculation?: components['schemas']['RecalculationMeta'] | null;
      };
    /** CashflowPatchReq */
    CashflowPatchReq: {
        /** Date */
        date?: string | null;
        /** Type */
        type?: string | null;
        /** Amount */
        amount?: string | null;
        /** Note */
        note?: string | null;
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
        tax?: string | null;
        /** Type */
        type?: string | null;
        /** Note */
        note?: string | null;
      };
    /** DividendOut */
    DividendOut: {
        /** Id */
        id: string;
        /** Securityid */
        securityId: string;
        /** Securitycode */
        securityCode?: string | null;
        /** Securityname */
        securityName?: string | null;
        /** Date */
        date: string;
        /** Amount */
        amount: string;
        /** Tax */
        tax: string;
        /** Netamount */
        netAmount: string;
        type: components['schemas']['DividendType'];
        /** Note */
        note?: string | null;
        /** Createdat */
        createdAt: string;
        /** Updatedat */
        updatedAt: string;
      };
    /** DividendPatchReq */
    DividendPatchReq: {
        /** Securityid */
        securityId?: string | null;
        /** Date */
        date?: string | null;
        /** Amount */
        amount?: string | null;
        /** Tax */
        tax?: string | null;
        /** Type */
        type?: string | null;
        /** Note */
        note?: string | null;
      };
    /** DividendType */
    DividendType: 'CASH' | 'STOCK_DIVIDEND';
    /** DrawdownPointOut */
    DrawdownPointOut: {
        /** Date */
        date: string;
        /** Drawdown */
        drawdown?: string | null;
        /** Peakdate */
        peakDate?: string | null;
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
    /** 数据导出类型（§4.2.17）。值即路由/服务层使用的字符串标识。 */
    ExportType: 'securities' | 'securityTrades' | 'cashFlows' | 'cashBalances' | 'securityPrices' | 'assetSnapshots' | 'navSeries';
    /** FreshnessOut */
    FreshnessOut: {
        /** Staledays */
        staleDays: number;
        /** Isstale */
        isStale: boolean;
        /** Latestpriceasof */
        latestPriceAsOf?: string | null;
        /** Latestpricelagdays */
        latestPriceLagDays?: number | null;
        /** Latestcashasof */
        latestCashAsOf?: string | null;
        /** Latestcashlagdays */
        latestCashLagDays?: number | null;
        /** Reasons */
        reasons?: components['schemas']['FreshnessReasonOut'][];
      };
    /** 单条「数据不新鲜」原因（对齐前端 FreshnessReason）。

- kind: ``PRICE`` / ``CASH``，驱动前端「去更新行情 / 去更新现金余额」按钮。
- asOf / lagDays: 该维度最新数据日期与滞后天数（``None`` 表示缺失记录）。
- label: 给前端展示的本地化文案。 */
    FreshnessReasonOut: {
        /** Kind */
        kind: string;
        /** Asof */
        asOf?: string | null;
        /** Lagdays */
        lagDays?: number | null;
        /** Label */
        label: string;
      };
    /** HTTPValidationError */
    HTTPValidationError: {
        /** Detail */
        detail?: components['schemas']['ValidationError'][];
      };
    /** 单标的持仓（对齐前端 HoldingResponse 字段命名）。

金额/数量均为字符串（Decimal → 字符串，防前端类型漂移，见信封契约）。 */
    HoldingOut: {
        /** Securityid */
        securityId: string;
        /** Securitycode */
        securityCode?: string;
        /** Securityname */
        securityName?: string;
        /** Securitytype */
        securityType?: string;
        /** Quantity */
        quantity: string;
        /** Avgcost */
        avgCost: string;
        /** Costtotal */
        costTotal: string;
        /** Marketprice */
        marketPrice?: string | null;
        /** Priceasof */
        priceAsOf?: string | null;
        /** Marketvalue */
        marketValue: string;
        /** Pnl */
        pnl: string;
        /** Pnlrate */
        pnlRate: string;
        /** Flag */
        flag: string;
      };
    /** 持仓汇总（对齐前端 HoldingsAggregate）。 */
    HoldingsAggregateOut: {
        /** Totalmarketvalue */
        totalMarketValue: string;
        /** Totalcost */
        totalCost: string;
        /** Totalprofit */
        totalProfit: string;
        /** Totalprofitrate */
        totalProfitRate: string;
        /** Securitycount */
        securityCount: number;
      };
    /** 持仓列表响应（信封 data 字段）：items + aggregate。 */
    HoldingsOut: {
        /** Items */
        items: components['schemas']['HoldingOut'][];
        aggregate: components['schemas']['HoldingsAggregateOut'];
      };
    /** 概览页「持仓市值」卡数据来源（缺陷4-A）。 */
    HoldingsSummaryOut: {
        /** Totalmarketvalue */
        totalMarketValue: string;
        /** Totalcost */
        totalCost: string;
        /** Totalprofit */
        totalProfit: string;
        /** Securitycount */
        securityCount: number;
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
        failed?: components['schemas']['ImportRowError'][];
        /** Recalculated */
        recalculated?: Record<string, unknown> | null;
      };
    /** ImportCommitReq */
    ImportCommitReq: {
        type: components['schemas']['ImportType'];
        /** Token */
        token: string;
      };
    /** 导入行级错误码（§4.2.17 校验阶段产生）。值即响应错误 dict 的 `code`。 */
    ImportErrorCode: 'MISSING_REQUIRED_COLUMN' | 'TOO_MANY_ROWS' | 'INVALID_DATE_FORMAT' | 'INVALID_DECIMAL_PRECISION' | 'INVALID_ENUM_VALUE' | 'SECURITY_NOT_FOUND' | 'DUPLICATE_SNAPSHOT_DATE';
    /** ImportPreviewOut */
    ImportPreviewOut: {
        type: components['schemas']['ImportType'];
        /** Totalrows */
        totalRows: number;
        /** Validrows */
        validRows: number;
        /** Sample */
        sample?: Record<string, unknown>[];
        /** Errors */
        errors?: components['schemas']['ImportRowError'][];
        /** Mindate */
        minDate?: string | null;
        /** Token */
        token: string;
      };
    /** 导入行级错误（§4.2.17）。`code` 为 ImportErrorCode 命名枚举。 */
    ImportRowError: {
        /** Row */
        row?: number | null;
        /** Field */
        field?: string | null;
        code: components['schemas']['ImportErrorCode'];
        /** Message */
        message: string;
      };
    /** 数据导入类型（§4.2.17）。值即路由/服务层使用的字符串标识。 */
    ImportType: 'securityTrades' | 'cashFlows' | 'assetSnapshots';
    /** InterfaceCategoryCreate */
    InterfaceCategoryCreate: {
        /** Label */
        label: string;
        /** Icon */
        icon?: string | null;
        /** Sort Order */
        sort_order?: number;
      };
    /** InterfaceCategoryUpdate */
    InterfaceCategoryUpdate: {
        /** Label */
        label?: string | null;
        /** Icon */
        icon?: string | null;
        /** Sort Order */
        sort_order?: number | null;
      };
    /** 提供方接口方向（入站 / 出站）。

PG 原生枚举类型名 `interface_direction`（由迁移创建）。
业务当前仅落库使用（默认 in），UI 不暴露该字段。 */
    InterfaceDirection: 'in' | 'out';
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
        value?: string | null;
        /** Cumulativenav */
        cumulativeNav?: string | null;
        /** Yearnav */
        yearNav?: string | null;
        /** Shares */
        shares?: string | null;
      };
    /** OverviewOut */
    OverviewOut: {
        /** Totalasset */
        totalAsset?: string | null;
        /** Cumulativexirr */
        cumulativeXirr?: string | null;
        /** Yearxirr */
        yearXirr?: string | null;
        holdingsSummary?: components['schemas']['HoldingsSummaryOut'] | null;
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
        archived?: boolean | null;
      };
    /** PortfolioCreateReq */
    PortfolioCreateReq: {
        /** Name */
        name: string;
        /** Description */
        description?: string | null;
        /** Currency */
        currency?: string;
      };
    /** PortfolioOut */
    PortfolioOut: {
        /** Id */
        id: string;
        /** Userid */
        userId: string;
        /** Name */
        name: string;
        /** Description */
        description?: string | null;
        /** Basedate */
        baseDate?: string | null;
        /** Currency */
        currency: string;
        /** Archivedat */
        archivedAt?: string | null;
        /** Createdat */
        createdAt: string;
        /** Updatedat */
        updatedAt: string;
      };
    /** PortfolioPatchReq */
    PortfolioPatchReq: {
        /** Name */
        name?: string | null;
        /** Description */
        description?: string | null;
      };
    /** PortfolioSummaryOut */
    PortfolioSummaryOut: {
        /** Cumulativexirr */
        cumulativeXirr?: string | null;
        /** Totalreturnrate */
        totalReturnRate?: string | null;
        /** Yearreturnrate */
        yearReturnRate?: string | null;
        /** Maxdrawdown */
        maxDrawdown?: string | null;
        /** Latestdate */
        latestDate?: string | null;
        /** Inceptiondate */
        inceptionDate: string;
      };
    /** 全部组合摘要行（GET /portfolios/summary · Web 客户端绑定此路径）。

与 PortfolioSummaryOut（单组合 Dashboard 卡片）是不同契约，不可混淆。 */
    PortfolioSummaryRow: {
        /** Id */
        id: string;
        /** Name */
        name: string;
        /** Totalasset */
        totalAsset: string;
        /** Holdingscount */
        holdingsCount: number;
        /** Lastupdatedat */
        lastUpdatedAt?: string | null;
        /** Basedate */
        baseDate?: string | null;
        /** Currency */
        currency: string;
        /** Createdat */
        createdAt: string;
        /** Cumulativenav */
        cumulativeNav?: string | null;
        /** Yearreturnrate */
        yearReturnRate?: string | null;
        /** Cumulativereturnrate */
        cumulativeReturnRate?: string | null;
        /** Xirr */
        xirr?: string | null;
        /** Netinvested */
        netInvested: string;
        /** Floatingprofit */
        floatingProfit?: string | null;
      };
    /** PreferenceOut */
    PreferenceOut: {
        /** Id */
        id: string;
        /** Defaultportfolioid */
        defaultPortfolioId?: string | null;
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
        /** Updatedat */
        updatedAt: string;
      };
    /** PricePatchReq */
    PricePatchReq: {
        /** Price */
        price?: string | null;
        /** Asof */
        asOf?: string | null;
      };
    /** ProfilePatchReq */
    ProfilePatchReq: {
        /** Name */
        name?: string | null;
        /** Avatar */
        avatar?: string | null;
        /** Phone */
        phone?: string | null;
        /** Bio */
        bio?: string | null;
      };
    /** QuoteInterfaceCreate */
    QuoteInterfaceCreate: {
        /** 接口分类 id（UUID，外键→interface_categories.id） */
        category_id: string;
        /** Name */
        name: string;
        /** Endpoint */
        endpoint?: string | null;
        /** Http Method */
        http_method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | null;
        /** Params */
        params?: Record<string, unknown> | null;
        /** Enabled */
        enabled?: boolean;
        /** Description */
        description?: string | null;
        direction?: components['schemas']['InterfaceDirection'];
        /** Timeout */
        timeout?: number | null;
        /** Retry Count */
        retry_count?: number | null;
        /** Rate Limit */
        rate_limit?: string | null;
      };
    /** QuoteInterfaceUpdate */
    QuoteInterfaceUpdate: {
        /** 接口分类 id（UUID），可空表示未分类 */
        category_id?: string | null;
        /** Name */
        name?: string | null;
        /** Endpoint */
        endpoint?: string | null;
        /** Http Method */
        http_method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | null;
        /** Params */
        params?: Record<string, unknown> | null;
        /** Enabled */
        enabled?: boolean | null;
        /** Description */
        description?: string | null;
        direction?: components['schemas']['InterfaceDirection'] | null;
        /** Timeout */
        timeout?: number | null;
        /** Retry Count */
        retry_count?: number | null;
        /** Rate Limit */
        rate_limit?: string | null;
      };
    /** 证券行情数据提供方接入方式（多提供方管理）。 */
    QuoteProviderAccessMethod: 'https' | 'sdk';
    /** QuoteProviderCreate */
    QuoteProviderCreate: {
        /** Name */
        name: string;
        access_method: components['schemas']['QuoteProviderAccessMethod'];
        /** Config */
        config: Record<string, unknown>;
        /** Enabled */
        enabled?: boolean;
        /** Description */
        description?: string | null;
      };
    /** QuoteProviderUpdate */
    QuoteProviderUpdate: {
        /** Name */
        name?: string | null;
        access_method?: components['schemas']['QuoteProviderAccessMethod'] | null;
        /** Config */
        config?: Record<string, unknown> | null;
        /** Enabled */
        enabled?: boolean | null;
        /** Description */
        description?: string | null;
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
        startDate?: string | null;
        /** Enddate */
        endDate?: string | null;
      };
    /** 重算反馈（完整对齐 app/ 的 recalculation 字段，修复 D3）。 */
    RecalculationMeta: {
        /** Fromdate */
        fromDate: string;
        /** Affecteddays */
        affectedDays: number;
        /** Skippedmanualdays */
        skippedManualDays: number;
      };
    /** RegisterReq */
    RegisterReq: {
        /** Email */
        email: string;
        /** Password */
        password: string;
        /** Name */
        name?: string | null;
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
        type?: string | null;
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
        type: components['schemas']['SecurityType'];
        /** Currency */
        currency: string;
        /** Createdat */
        createdAt: string;
        /** Updatedat */
        updatedAt: string;
      };
    /** SecurityPatchReq */
    SecurityPatchReq: {
        /** Name */
        name?: string | null;
        /** Type */
        type?: string | null;
      };
    /** SecuritySide */
    SecuritySide: 'BUY_SEC' | 'SELL_SEC';
    /** SecurityType */
    SecurityType: 'STOCK' | 'ON_EXCHANGE_FUND' | 'BOND' | 'OTHER' | 'HK_STOCK' | 'CONVERTIBLE_BOND' | 'INDEX' | 'OFF_EXCHANGE_FUND';
    /** SnapshotCreateReq */
    SnapshotCreateReq: {
        /** Date */
        date: string;
        /** Totalasset */
        totalAsset: string;
        /** Marketvalue */
        marketValue?: string | null;
        /** Cashbalance */
        cashBalance?: string | null;
        /** Note */
        note?: string | null;
      };
    /** SnapshotOut */
    SnapshotOut: {
        /** Id */
        id: string;
        /** Portfolioid */
        portfolioId: string;
        /** Date */
        date: string;
        /** Totalasset */
        totalAsset?: string | null;
        /** Marketvalue */
        marketValue?: string | null;
        /** Cashbalance */
        cashBalance?: string | null;
        source: components['schemas']['SnapshotSource'];
        valuationFlag: components['schemas']['SnapshotValuation'];
        /** Note */
        note?: string | null;
        /** Recordedat */
        recordedAt: string;
        /** Createdat */
        createdAt: string;
        /** Updatedat */
        updatedAt: string;
        /** Derivedtotalasset */
        derivedTotalAsset?: string | null;
      };
    /** SnapshotPatchReq */
    SnapshotPatchReq: {
        /** Totalasset */
        totalAsset?: string | null;
        /** Marketvalue */
        marketValue?: string | null;
        /** Cashbalance */
        cashBalance?: string | null;
        /** Note */
        note?: string | null;
      };
    /** SnapshotSource */
    SnapshotSource: 'DERIVED' | 'MANUAL';
    /** SnapshotValuation */
    SnapshotValuation: 'EXACT' | 'CARRIED_FORWARD' | 'COST_BASED' | 'MANUAL_INPUT';
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
        /** Costprice */
        costPrice: string;
        /** Feetotal */
        feeTotal?: string | null;
        /** Commission */
        commission?: string | null;
        /** Stamptax */
        stampTax?: string | null;
        /** Other */
        other?: string | null;
        /** Note */
        note?: string | null;
      };
    /** TradeOut */
    TradeOut: {
        /** Id */
        id: string;
        /** Securityid */
        securityId: string;
        /** Date */
        date: string;
        side: components['schemas']['SecuritySide'];
        /** Quantity */
        quantity: string;
        /** Costprice */
        costPrice: string;
        /** Commission */
        commission: string;
        /** Stamptax */
        stampTax: string;
        /** Other */
        other: string;
        /** Feetotal */
        feeTotal: string;
        /** Note */
        note?: string | null;
        /** Createdat */
        createdAt: string;
        /** Updatedat */
        updatedAt: string;
      };
    /** TradePatchReq */
    TradePatchReq: {
        /** Date */
        date?: string | null;
        /** Side */
        side?: string | null;
        /** Quantity */
        quantity?: string | null;
        /** Costprice */
        costPrice?: string | null;
        /** Feetotal */
        feeTotal?: string | null;
        /** Commission */
        commission?: string | null;
        /** Stamptax */
        stampTax?: string | null;
        /** Other */
        other?: string | null;
        /** Note */
        note?: string | null;
      };
    /** UserPublicOut */
    UserPublicOut: {
        /** Id */
        id: string;
        /** Email */
        email: string;
        /** Name */
        name: string | null;
        /** Avatar */
        avatar?: string | null;
        /** Phone */
        phone?: string | null;
        /** Bio */
        bio?: string | null;
        /** Role */
        role?: string;
        /** Createdat */
        createdAt: string;
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
        xirrValue?: string | null;
      };
    /** XirrPointOut */
    XirrPointOut: {
        /** Date */
        date: string;
        /** Value */
        value?: string | null;
      };
  };
}


// ── Generated from backend/app/core/enums.py BusinessErrorCode (single source of truth) ──
export const BUSINESS_ERROR_CODE = {
  SUCCESS: 0,
  UNAUTHORIZED: 1001,
  TOKEN_EXPIRED: 1002,
  EMAIL_TAKEN: 1003,
  PASSWORD_WRONG: 1004,
  FILE_INVALID: 1006,
  PENDING_DELETION: 1007,
  ACCOUNT_NOT_DELETED: 1008,
  RESTORE_EXPIRED: 1009,
  VALIDATION_FAILED: 2000,
  NOT_FOUND: 3001,
  FORBIDDEN: 4001,
  INTERNAL_ERROR: 5000,
} as const;
export type BusinessErrorCode = (typeof BUSINESS_ERROR_CODE)[keyof typeof BUSINESS_ERROR_CODE];
