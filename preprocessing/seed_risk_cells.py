"""Load the susceptibility artefact into the RiskCells table.

    python seed_risk_cells.py [--dry-run]

Run once after deployment, and again whenever the terrain model changes.
Seeding is idempotent: cells are written by primary key, so a re-run
overwrites rather than duplicates.

Only the static terrain fields are written here. Forecast rainfall, the
computed score, the risk level and the explanation sentence are owned by the
hourly scoring job and are deliberately left absent until it first runs.
"""

from __future__ import annotations

import argparse
import json
from decimal import Decimal

import boto3

import config

STACK_NAME = "accra-flood-watch"
REGION = "eu-west-1"


def resolve_table_name() -> str:
    """Read the table name from the deployed stack rather than hardcoding it."""
    cloudformation = boto3.client("cloudformation", region_name=REGION)
    stack = cloudformation.describe_stacks(StackName=STACK_NAME)["Stacks"][0]
    for output in stack["Outputs"]:
        if output["OutputKey"] == "RiskCellsTableName":
            return output["OutputValue"]
    raise RuntimeError("RiskCellsTableName not found in stack outputs.")


def seed(dry_run: bool = False) -> None:
    if not config.SUSCEPTIBILITY_OUTPUT.exists():
        raise SystemExit(
            f"No artefact at {config.SUSCEPTIBILITY_OUTPUT}.\n"
            "Run build_susceptibility.py first."
        )

    artefact = json.loads(config.SUSCEPTIBILITY_OUTPUT.read_text(encoding="utf-8"))
    cells = artefact["cells"]

    print(f"Artefact generated {artefact['generatedAt']}")
    print(f"  cells            : {len(cells)}")
    print(f"  geohash precision: {artefact['geohashPrecision']}")
    print(f"  historical points: {artefact['historicalPointsApplied']}")

    unverified = artefact.get("historicalPointsUnverified", 0)
    if unverified:
        print(
            f"  WARNING          : {unverified} historical points are unverified "
            "(see flood_points.py)"
        )

    if dry_run:
        print("\nDry run, nothing written.")
        print("Sample item:")
        print(json.dumps(cells[0], indent=2))
        return

    table_name = resolve_table_name()
    print(f"  target table     : {table_name}\n")

    table = boto3.resource("dynamodb", region_name=REGION).Table(table_name)

    written = 0
    # batch_writer handles batching, retries and unprocessed-item resubmission.
    with table.batch_writer(overwrite_by_pkeys=["cellPrefix", "cell"]) as batch:
        for cell in cells:
            item = {
                # Partition by prefix, sort by full cell: one Query returns
                # every grid cell in ~1.2km x 0.6km.
                "cellPrefix": cell["cell"][: config.PREFIX_PRECISION],
                "cell": cell["cell"],
                "susceptibility": Decimal(str(cell["susceptibility"])),
                "hand": Decimal(str(cell["hand"])),
                "slope": Decimal(str(cell["slope"])),
                "elevation": Decimal(str(cell["elevation"])),
                "geohashPrecision": artefact["geohashPrecision"],
                "terrainGeneratedAt": artefact["generatedAt"],
            }
            if cell["historicalFloodPoint"]:
                item["historicalFloodPoint"] = cell["historicalFloodPoint"]
            batch.put_item(Item=item)
            written += 1
            if written % 250 == 0:
                print(f"  written {written}/{len(cells)}")

    print(f"\nSeeded {written} cells into {table_name}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be written without touching DynamoDB.",
    )
    seed(dry_run=parser.parse_args().dry_run)
