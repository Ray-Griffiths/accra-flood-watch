/**
 * Shared DynamoDB document client.
 *
 * Instantiated at module scope so warm invocations reuse the connection rather
 * than renegotiating TLS on every request.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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
