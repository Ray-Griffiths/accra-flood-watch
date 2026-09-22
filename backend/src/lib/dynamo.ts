/**
 * Shared DynamoDB document client.
 *
 * Instantiated at module scope so warm invocations reuse the connection rather
 * than renegotiating TLS on every request.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});

export const documents = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
});

export function requireTable(variable: string): string {
  const name = process.env[variable];
  if (!name) throw new Error(`Missing environment variable ${variable}`);
  return name;
}

/**
 * Every item matching a query, following pagination to the end.
 *
 * DynamoDB caps a single Query response at 1MB and hands back a
 * `LastEvaluatedKey` when it stopped early. A bare `send` that ignores it does
 * not fail — it silently returns part of the partition, which in this system
 * is the worst possible shape of bug:
 *
 *   - a viewport quietly missing cells renders as ground at low risk;
 *   - a route corridor quietly missing reports is a road presented as clear
 *     when somebody is standing in water on it.
 *
 * At 32 cells per partition today neither is reachable. But a busy reports
 * partition during a flood is exactly when a partition grows, and exactly when
 * being wrong matters, so the loop is here rather than in a comment saying it
 * is not needed yet.
 *
 * The page cap is a safety valve against an unbounded partition holding a
 * handler open until it times out. It is far above any partition this schema
 * can produce, and it logs loudly if it is ever reached.
 */
const MAX_QUERY_PAGES = 25;

export async function queryAll<T>(command: QueryCommand): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  let pages = 0;

  do {
    const page: QueryCommandOutput = await documents.send(
      startKey
        ? new QueryCommand({ ...command.input, ExclusiveStartKey: startKey })
        : command,
    );

    items.push(...((page.Items ?? []) as T[]));
    startKey = page.LastEvaluatedKey;
    pages += 1;

    if (startKey && pages >= MAX_QUERY_PAGES) {
      console.error(
        `Stopped paginating ${command.input.TableName} after ${pages} pages; ` +
          "a partition has grown beyond what this access pattern assumes.",
      );
      break;
    }
  } while (startKey);

  return items;
}
