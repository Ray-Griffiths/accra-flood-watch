/**
 * CloudWatch metrics via Embedded Metric Format.
 *
 * A structured log line becomes a metric without a PutMetricData call, which
 * means no extra API request, no extra latency on the path that emits it, and
 * no IAM grant for cloudwatch:PutMetricData anywhere in the stack.
 *
 * The alarms depend on this: `CellsScored` is emitted on every successful
 * scoring run, so three hours of *no data* is itself the alarm condition. A
 * metric that is only emitted on failure cannot detect a job that stopped
 * running altogether.
 */

export function emitMetrics(metrics: Record<string, number>): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "AccraFloodWatch",
            Dimensions: [["Environment"]],
            Metrics: Object.keys(metrics).map((Name) => ({ Name })),
          },
        ],
      },
      Environment: process.env["ENVIRONMENT"] ?? "unknown",
      ...metrics,
    }),
  );
}
