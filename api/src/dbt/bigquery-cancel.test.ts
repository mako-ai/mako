import { describe, expect, it } from "vitest";
import { extractBigQueryJobIds } from "./bigquery-cancel.service";

describe("extractBigQueryJobIds", () => {
  it("parses the console URL dbt prints per node (with location)", () => {
    const line =
      "View job in the BigQuery console: " +
      "https://console.cloud.google.com/bigquery?project=my-proj&j=bq:US:abc123-def456&page=queryresults";
    expect(extractBigQueryJobIds(line)).toEqual([
      { jobId: "abc123-def456", location: "US" },
    ]);
  });

  it("parses a REST job path", () => {
    const line =
      "POST https://bigquery.googleapis.com/bigquery/v2/projects/p/jobs/job_AbC-123";
    expect(extractBigQueryJobIds(line)).toEqual([{ jobId: "job_AbC-123" }]);
  });

  it("parses a structured job_id mention", () => {
    expect(extractBigQueryJobIds('{"job_id": "script_job_99"}')).toEqual([
      { jobId: "script_job_99" },
    ]);
    expect(extractBigQueryJobIds("Job ID: dbt-run-7788")).toEqual([
      { jobId: "dbt-run-7788" },
    ]);
  });

  it("prefers the location-bearing console URL when a job id appears twice", () => {
    const line =
      "url?x=1&j=bq:EU:dup-job-1 ... later mentions job_id=dup-job-1 again";
    expect(extractBigQueryJobIds(line)).toEqual([
      { jobId: "dup-job-1", location: "EU" },
    ]);
  });

  it("returns nothing for unrelated log lines", () => {
    expect(extractBigQueryJobIds("Running with dbt=1.8.0")).toEqual([]);
    expect(extractBigQueryJobIds("")).toEqual([]);
  });
});
