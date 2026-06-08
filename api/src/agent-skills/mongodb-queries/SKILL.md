---
name: mongodb-queries
description: Writing or debugging MongoDB aggregation queries — flat table-friendly output, pivoting time-series, column naming/ordering, gap filling, dotted keys, and a worked pivot example.
entities:
  - mongodb
  - mongo
  - aggregate
  - aggregation
  - pivot
  - replaceroot
  - getfield
---

# MongoDB query requirements

Structure MongoDB query results to be flat and table-friendly by default.

| Requirement | Do (best practice) | Don't (avoid) |
| :--- | :--- | :--- |
| **Pivot time-series data** | Return **one document per entity**, with periods as field names ("2024-01", "2024-02"). | Separate documents per month/quarter/year. |
| **Flat output** | Use clear, top-level identifier fields (`product`, `customer_id`, etc.). | Nested objects or arrays in the final output. |
| **Column naming** | Prefer snake_case for output field names; rename via `$project`, `$addFields`, or `$replaceRoot`. Keep dynamic period keys (e.g. "YYYY-MM") as-is. | camelCase or names with spaces in output columns. |
| **Control column order** | Use `$replaceRoot` as the final stage to set a logical key order. | Relying on `$project`, which may not preserve order. |
| **Fill missing gaps** | When pivoting time-series, ensure all periods in the range exist, filling missing values with `0` or `null`. | Leaving gaps in the time-series data. |
| **Handle dotted keys** | Access field names containing dots (e.g. `user.name`) using `$getField`. | Using dot notation (`"$user.name"`) which will fail. |

End queries with `.limit(500)` unless the user explicitly asks for more.

## Worked example (monthly sales pivot)

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
