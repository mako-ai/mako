---
name: mongodb-queries
description: Load when writing or debugging MongoDB find or aggregate queries, especially table-friendly output, pivots, dotted keys, date bucketing, projections, limits, and aggregation pipelines.
---

# MongoDB query requirements

Structure MongoDB query results to be flat and table-friendly by default.

| Requirement | Do (best practice) | Do not |
| :--- | :--- | :--- |
| Pivot time-series data | Return one document per entity, with periods as field names (`"2024-01"`, `"2024-02"`). | Return separate documents per month/quarter/year when the user expects a table. |
| Flat output | Use clear top-level identifier fields (`product`, `customer_id`). | Return nested objects or arrays in the final output. |
| Column naming | Prefer snake_case via `$project`, `$addFields`, or `$replaceRoot`. Keep dynamic period keys as-is. | Use camelCase or names with spaces in output columns. |
| Column order | Use `$replaceRoot` as the final stage to set a logical key order. | Rely on `$project` when exact order matters. |
| Missing gaps | If pivoting time series, fill missing periods with `0` or `null`. | Leave gaps in time-series data. |
| Dotted keys | Access field names containing dots with `$getField`. | Use standard dot notation (`"$user.name"`) for literal dotted keys. |

## Example: monthly sales pivot

```javascript
// db: ecommerce
db.orders.aggregate([
  {
    $match: {
      status: "completed",
      orderDate: { $gte: ISODate("2024-01-01"), $lt: ISODate("2025-01-01") }
    }
  },
  {
    $group: {
      _id: {
        product: "$productName",
        month: { $dateToString: { format: "%Y-%m", date: "$orderDate" } }
      },
      total_sales: { $sum: "$saleAmount" }
    }
  },
  {
    $group: {
      _id: "$_id.product",
      monthly_sales: { $push: { k: "$_id.month", v: "$total_sales" } }
    }
  },
  {
    $replaceRoot: {
      newRoot: {
        $mergeObjects: [ { product: "$_id" }, { $arrayToObject: "$monthly_sales" } ]
      }
    }
  }
]).limit(500);
```

This pivots monthly sales so each product is one row with months as columns.
