export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  dataSources: Array<{
    placeholder: string;
    description: string;
    requiredColumns: string[];
  }>;
  widgets: Array<{
    title: string;
    type: "chart" | "kpi" | "table";
    localSql: string;
    vegaLiteSpec?: Record<string, unknown>;
    kpiConfig?: {
      valueField: string;
      format?: string;
      comparisonField?: string;
      comparisonLabel?: string;
    };
    tableConfig?: { columns?: string[]; pageSize?: number };
    layouts: {
      lg: { x: number; y: number; w: number; h: number };
      md?: { x: number; y: number; w: number; h: number };
      sm?: { x: number; y: number; w: number; h: number };
      xs?: { x: number; y: number; w: number; h: number };
    };
  }>;
  globalFilters: Array<{
    type: "date-range" | "select" | "multi-select" | "search";
    label: string;
    placeholder: string;
    column: string;
  }>;
}

export const dashboardTemplates: DashboardTemplate[] = [
  {
    id: "sales-overview",
    name: "Sales Overview",
    description: "Revenue trends, top products, and regional breakdown",
    category: "Business",
    dataSources: [
      {
        placeholder: "orders",
        description:
          "Order/sales data with date, amount, product, and region columns",
        requiredColumns: ["date", "amount"],
      },
    ],
    widgets: [
      {
        title: "Revenue Over Time",
        type: "chart",
        localSql:
          "SELECT date_trunc('month', date) AS month, SUM(amount) AS revenue FROM \"orders\" GROUP BY 1 ORDER BY 1",
        vegaLiteSpec: {
          mark: { type: "area", line: true, opacity: 0.3 },
          encoding: {
            x: {
              field: "month",
              type: "temporal",
              timeUnit: "yearmonth",
              title: "Month",
            },
            y: { field: "revenue", type: "quantitative", title: "Revenue" },
            tooltip: [
              { field: "month", type: "temporal", timeUnit: "yearmonth" },
              { field: "revenue", type: "quantitative", format: "$,.0f" },
            ],
          },
        },
        layouts: { lg: { x: 0, y: 0, w: 8, h: 4 } },
      },
      {
        title: "Total Revenue",
        type: "kpi",
        localSql: 'SELECT SUM(amount) AS total FROM "orders"',
        kpiConfig: { valueField: "total", format: "$,.0f" },
        layouts: { lg: { x: 8, y: 0, w: 4, h: 2 } },
      },
      {
        title: "Order Count",
        type: "kpi",
        localSql: 'SELECT COUNT(*) AS count FROM "orders"',
        kpiConfig: { valueField: "count" },
        layouts: { lg: { x: 8, y: 2, w: 4, h: 2 } },
      },
      {
        title: "Recent Orders",
        type: "table",
        localSql: 'SELECT * FROM "orders" ORDER BY date DESC LIMIT 100',
        tableConfig: { pageSize: 25 },
        layouts: { lg: { x: 0, y: 4, w: 12, h: 5 } },
      },
    ],
    globalFilters: [
      {
        type: "date-range",
        label: "Date Range",
        placeholder: "orders",
        column: "date",
      },
    ],
  },
  {
    id: "user-analytics",
    name: "User Analytics",
    description: "User growth, activity patterns, and engagement metrics",
    category: "Product",
    dataSources: [
      {
        placeholder: "users",
        description:
          "User data with signup date, activity, and segment columns",
        requiredColumns: ["created_at"],
      },
    ],
    widgets: [
      {
        title: "User Growth",
        type: "chart",
        localSql:
          "SELECT date_trunc('week', created_at) AS week, COUNT(*) AS new_users FROM \"users\" GROUP BY 1 ORDER BY 1",
        vegaLiteSpec: {
          mark: { type: "bar", cornerRadiusEnd: 4 },
          encoding: {
            x: {
              field: "week",
              type: "temporal",
              timeUnit: "yearmonthdate",
              title: "Week",
            },
            y: { field: "new_users", type: "quantitative", title: "New Users" },
            tooltip: [
              { field: "week", type: "temporal" },
              { field: "new_users", type: "quantitative" },
            ],
          },
        },
        layouts: { lg: { x: 0, y: 0, w: 12, h: 4 } },
      },
      {
        title: "Total Users",
        type: "kpi",
        localSql: 'SELECT COUNT(*) AS total FROM "users"',
        kpiConfig: { valueField: "total" },
        layouts: { lg: { x: 0, y: 4, w: 4, h: 2 } },
      },
    ],
    globalFilters: [],
  },
  {
    id: "financial-summary",
    name: "Financial Summary",
    description: "Income, expenses, and profit/loss overview",
    category: "Finance",
    dataSources: [
      {
        placeholder: "transactions",
        description:
          "Financial transactions with date, amount, type, and category",
        requiredColumns: ["date", "amount", "type"],
      },
    ],
    widgets: [
      {
        title: "Income vs Expenses",
        type: "chart",
        localSql:
          "SELECT date_trunc('month', date) AS month, type, SUM(amount) AS total FROM \"transactions\" GROUP BY 1, 2 ORDER BY 1",
        vegaLiteSpec: {
          mark: { type: "bar" },
          encoding: {
            x: { field: "month", type: "temporal", timeUnit: "yearmonth" },
            y: { field: "total", type: "quantitative", title: "Amount" },
            color: { field: "type", type: "nominal" },
            tooltip: [
              { field: "month", type: "temporal" },
              { field: "type", type: "nominal" },
              { field: "total", type: "quantitative", format: "$,.0f" },
            ],
          },
        },
        layouts: { lg: { x: 0, y: 0, w: 12, h: 4 } },
      },
      {
        title: "Net Income",
        type: "kpi",
        localSql:
          "SELECT SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END) AS net FROM \"transactions\"",
        kpiConfig: { valueField: "net", format: "$,.0f" },
        layouts: { lg: { x: 0, y: 4, w: 4, h: 2 } },
      },
    ],
    globalFilters: [
      {
        type: "date-range",
        label: "Period",
        placeholder: "transactions",
        column: "date",
      },
    ],
  },
];
