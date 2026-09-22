/**
 * Loading the Web Push signing keys.
 *
 * Extracted from the scoring handler once a second code path needed them: the
 * immediate alert fired when a resident's report is what confirms a cell.
 *
 * The private half is a SecureString, which CloudFormation cannot create, so
 * both parameters are provisioned out of band and the template grants access
 * by name. A stack without them scores normally and sends nothing — the right
 * failure, since the map staying current matters more than the alerts.
 */

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import type { VapidKeys } from "./dispatch.ts";

const ssm = new SSMClient({});

/**
 * Returns null rather than throwing on every failure path.
 *
 * A caller that cannot send alerts must still finish its real work. Scoring
 * must write the hour's numbers; a report must still be recorded and
 * acknowledged to the person standing in the water. Missing keys are a
 * degraded alerting path, not a failed request.
 */
export async function loadVapidKeys(): Promise<VapidKeys | null> {
  const publicName = process.env["VAPID_PUBLIC_PARAMETER"];
  const privateName = process.env["VAPID_PRIVATE_PARAMETER"];
  if (!publicName || !privateName) return null;

  try {
    const [publicResult, privateResult] = await Promise.all([
      ssm.send(new GetParameterCommand({ Name: publicName })),
      ssm.send(new GetParameterCommand({ Name: privateName, WithDecryption: true })),
    ]);

    const publicKey = publicResult.Parameter?.Value;
    const privateKey = privateResult.Parameter?.Value;
    if (!publicKey || !privateKey) return null;

    return {
      publicKey,
      privateKey,
      subject: process.env["VAPID_SUBJECT"] ?? "mailto:accrafloodwatch@example.com",
    };
  } catch (error) {
    console.error("Could not load VAPID keys; alerts will not be sent", error);
    return null;
  }
}
