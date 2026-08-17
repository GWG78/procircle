#!/usr/bin/env python3
"""
Upload swatch crops (produced by generate_swatches.py) to Shopify and attach
them to every size variant of the matching color.

Credentials (required, read from environment):
    SHOPIFY_STORE_DOMAIN   e.g. new26-forwardoutdoor.myshopify.com
    SHOPIFY_ACCESS_TOKEN   Admin API access token from a custom app with the
                            write_products scope.

Usage:
    python3 upload_variant_media.py --library-root "/path" --dry-run --limit 6
    python3 upload_variant_media.py --library-root "/path" --limit 5
    python3 upload_variant_media.py --library-root "/path"
    python3 upload_variant_media.py --library-root "/path" --overwrite

Re-run safely: variants that already have media attached are skipped unless
--overwrite is passed. Failed uploads are logged and don't stop the run.
"""

import argparse
import csv
import getpass
import mimetypes
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import requests

API_VERSION = "2026-07"  # confirmed current stable version at build time; bump periodically

SWATCH_RE = re.compile(r"(?P<sep>[ _])swatch(?P<digit>\d*)(?=\.[^.]+$)", re.IGNORECASE)
SKU_SHAPE_RE = re.compile(r"^[A-Z0-9]+(-[A-Z0-9]+)+$")

MEDIA_POLL_INTERVAL = 2.0
MEDIA_POLL_TIMEOUT = 45.0


class ShopifyGraphQLError(Exception):
    pass


class ShopifyClient:
    def __init__(self, domain: str, token: str, api_version: str = API_VERSION):
        self.endpoint = f"https://{domain}/admin/api/{api_version}/graphql.json"
        self.session = requests.Session()
        self.session.headers.update({
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        })

    def execute(self, query: str, variables: Optional[dict] = None, max_retries: int = 6) -> dict:
        attempt = 0
        while True:
            attempt += 1
            resp = self.session.post(
                self.endpoint,
                json={"query": query, "variables": variables or {}},
                timeout=60,
            )
            if resp.status_code == 429:
                wait = float(resp.headers.get("Retry-After", 2))
                time.sleep(wait)
                continue
            resp.raise_for_status()
            payload = resp.json()
            errors = payload.get("errors")
            if errors:
                codes = {e.get("extensions", {}).get("code") for e in errors}
                if "THROTTLED" in codes and attempt <= max_retries:
                    wait = self._throttle_wait(errors, attempt)
                    time.sleep(wait)
                    continue
                raise ShopifyGraphQLError(str(errors))
            return payload["data"]

    @staticmethod
    def _throttle_wait(errors, attempt) -> float:
        for e in errors:
            cost = e.get("extensions", {}).get("cost")
            if cost:
                throttle = cost.get("throttleStatus", {})
                available = throttle.get("currentlyAvailable", 0)
                restore_rate = throttle.get("restoreRate", 50)
                requested = cost.get("requestedQueryCost", 0)
                needed = max(requested - available, 0)
                if restore_rate:
                    return max(needed / restore_rate, 1.0)
        return min(2 ** attempt, 30)


# ---------------------------------------------------------------------------
# Library walking (mirrors generate_swatches.py)
# ---------------------------------------------------------------------------

def is_accessories_path(path: Path, library_root: Path) -> bool:
    rel = path.relative_to(library_root)
    for part in rel.parts[:-1]:
        if "accessories" in part.lower():
            return True
    return False


def find_swatch_targets(library_root: Path):
    for path in sorted(library_root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        if is_accessories_path(path, library_root):
            continue
        m = SWATCH_RE.search(path.name)
        if not m:
            continue
        yield path


def resolve_color_sku(path: Path) -> Optional[str]:
    folder_name = path.parent.name.strip()
    if not folder_name:
        return None
    token = folder_name.split()[-1]
    if SKU_SHAPE_RE.match(token):
        return token
    return None


def resolve_color_name(path: Path, color_sku: str) -> str:
    folder_name = path.parent.name.strip()
    if folder_name.endswith(color_sku):
        remainder = folder_name[: -len(color_sku)].strip()
        if remainder:
            return remainder
    return folder_name


# ---------------------------------------------------------------------------
# Shopify lookups
# ---------------------------------------------------------------------------

FIND_VARIANTS_QUERY = """
query FindVariants($q: String!) {
  productVariants(first: 100, query: $q) {
    edges {
      node {
        id
        sku
        product { id title }
        media(first: 1) { edges { node { id } } }
      }
    }
  }
}
"""


@dataclass
class MatchResult:
    product_id: Optional[str] = None
    product_title: Optional[str] = None
    variant_ids: list = field(default_factory=list)
    variant_skus: list = field(default_factory=list)
    already_has_media: bool = False
    multiple_products: bool = False
    product_ids_seen: list = field(default_factory=list)


def find_matching_variants(client: ShopifyClient, color_sku: str) -> MatchResult:
    data = client.execute(FIND_VARIANTS_QUERY, {"q": f"sku:{color_sku}*"})
    edges = data["productVariants"]["edges"]
    prefix = color_sku + "-"

    by_product = {}
    for edge in edges:
        node = edge["node"]
        sku = node["sku"] or ""
        if not sku.startswith(prefix):
            continue
        pid = node["product"]["id"]
        by_product.setdefault(pid, {"title": node["product"]["title"], "variants": []})
        has_media = len(node["media"]["edges"]) > 0
        by_product[pid]["variants"].append((node["id"], sku, has_media))

    result = MatchResult()
    result.product_ids_seen = list(by_product.keys())
    if not by_product:
        return result
    if len(by_product) > 1:
        result.multiple_products = True
        return result

    ((pid, info),) = by_product.items()
    result.product_id = pid
    result.product_title = info["title"]
    result.variant_ids = [v[0] for v in info["variants"]]
    result.variant_skus = [v[1] for v in info["variants"]]
    result.already_has_media = any(v[2] for v in info["variants"])
    return result


# ---------------------------------------------------------------------------
# Upload + attach
# ---------------------------------------------------------------------------

STAGED_UPLOADS_CREATE = """
mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets {
      url
      resourceUrl
      parameters { name value }
    }
    userErrors { field message }
  }
}
"""

PRODUCT_UPDATE_MEDIA = """
mutation ProductUpdateMedia($id: ID!, $media: [CreateMediaInput!]) {
  productUpdate(product: { id: $id }, media: $media) {
    product {
      id
      media(first: 1, reverse: true) {
        edges { node { id status } }
      }
    }
    userErrors { field message }
  }
}
"""

POLL_MEDIA_STATUS = """
query PollMedia($id: ID!) {
  node(id: $id) {
    ... on MediaImage {
      id
      status
      fileErrors { message code }
    }
  }
}
"""

APPEND_VARIANT_MEDIA = """
mutation AppendVariantMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
  productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
    productVariants { id }
    userErrors { field message }
  }
}
"""


class UploadError(Exception):
    pass


def create_staged_upload(client: ShopifyClient, filename: str, mime_type: str) -> dict:
    variables = {"input": [{
        "resource": "IMAGE",
        "filename": filename,
        "mimeType": mime_type,
        "httpMethod": "POST",
    }]}
    data = client.execute(STAGED_UPLOADS_CREATE, variables)
    payload = data["stagedUploadsCreate"]
    if payload["userErrors"]:
        raise UploadError(f"stagedUploadsCreate: {payload['userErrors']}")
    return payload["stagedTargets"][0]


def upload_bytes_to_staged_target(target: dict, file_path: Path, mime_type: str):
    ordered_files = [(p["name"], (None, p["value"])) for p in target["parameters"]]
    with open(file_path, "rb") as f:
        ordered_files.append(("file", (file_path.name, f.read(), mime_type)))
    resp = requests.post(target["url"], files=ordered_files, timeout=120)
    if resp.status_code not in (200, 201, 204):
        raise UploadError(f"staged upload POST failed: {resp.status_code} {resp.text[:500]}")


def create_product_media(client: ShopifyClient, product_id: str, resource_url: str, alt_text: str) -> str:
    variables = {
        "id": product_id,
        "media": [{
            "originalSource": resource_url,
            "alt": alt_text,
            "mediaContentType": "IMAGE",
        }],
    }
    data = client.execute(PRODUCT_UPDATE_MEDIA, variables)
    payload = data["productUpdate"]
    if payload["userErrors"]:
        raise UploadError(f"productUpdate(media): {payload['userErrors']}")
    edges = payload["product"]["media"]["edges"]
    if not edges:
        raise UploadError("productUpdate(media) returned no media edge")
    return edges[0]["node"]["id"]


def poll_media_ready(client: ShopifyClient, media_id: str) -> str:
    deadline = time.monotonic() + MEDIA_POLL_TIMEOUT
    status = "UNKNOWN"
    while time.monotonic() < deadline:
        data = client.execute(POLL_MEDIA_STATUS, {"id": media_id})
        node = data.get("node")
        if node is None:
            return status
        status = node["status"]
        if status == "READY":
            return status
        if status == "FAILED":
            errs = node.get("fileErrors", [])
            raise UploadError(f"media processing failed: {errs}")
        time.sleep(MEDIA_POLL_INTERVAL)
    return status  # timed out, still PROCESSING/UPLOADED - caller decides how to treat it


def append_media_to_variants(client: ShopifyClient, product_id: str, variant_ids: list, media_id: str):
    variant_media = [{"variantId": vid, "mediaIds": [media_id]} for vid in variant_ids]
    data = client.execute(APPEND_VARIANT_MEDIA, {"productId": product_id, "variantMedia": variant_media})
    payload = data["productVariantAppendMedia"]
    if payload["userErrors"]:
        raise UploadError(f"productVariantAppendMedia: {payload['userErrors']}")


# ---------------------------------------------------------------------------
# Row / manifest
# ---------------------------------------------------------------------------

@dataclass
class Row:
    file_path: str
    color_sku: str = ""
    product_title: str = ""
    product_id: str = ""
    variant_count: int = 0
    status: str = ""
    reason: str = ""


def process_swatch(path: Path, client: ShopifyClient, dry_run: bool, overwrite: bool) -> Row:
    row = Row(file_path=str(path))

    color_sku = resolve_color_sku(path)
    if color_sku is None:
        row.status = "skipped-no-sku"
        row.reason = f"folder name doesn't yield a SKU: {path.parent.name!r}"
        return row
    row.color_sku = color_sku

    try:
        match = find_matching_variants(client, color_sku)
    except (ShopifyGraphQLError, requests.RequestException) as e:
        row.status = "error"
        row.reason = f"variant lookup failed: {e}"
        return row

    if match.multiple_products:
        row.status = "skipped-multiple-products"
        row.reason = f"SKU prefix matched variants across products: {match.product_ids_seen}"
        return row

    if not match.product_id:
        row.status = "skipped-no-match"
        row.reason = "no matching product/color in Shopify"
        return row

    row.product_title = match.product_title
    row.product_id = match.product_id
    row.variant_count = len(match.variant_ids)

    if match.already_has_media and not overwrite:
        row.status = "skipped-already-has-image"
        row.reason = "at least one matched variant already has media attached"
        return row

    color_name = resolve_color_name(path, color_sku)
    alt_text = f"{match.product_title} – {color_name}"

    if dry_run:
        row.status = "would-upload"
        row.reason = (f"would attach to {row.variant_count} variant(s) "
                       f"({', '.join(match.variant_skus)}); alt={alt_text!r}")
        return row

    mime_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    try:
        target = create_staged_upload(client, path.name, mime_type)
        upload_bytes_to_staged_target(target, path, mime_type)
        media_id = create_product_media(client, match.product_id, target["resourceUrl"], alt_text)
        final_status = poll_media_ready(client, media_id)
        append_media_to_variants(client, match.product_id, match.variant_ids, media_id)
    except (UploadError, ShopifyGraphQLError, requests.RequestException) as e:
        row.status = "error"
        row.reason = str(e)
        return row

    row.status = "uploaded"
    if final_status != "READY":
        row.reason = f"attached; media still {final_status} at upload time (Shopify will finish processing)"
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--library-root", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true",
                         help="Print the plan (matched variants, product, media) without calling any write mutations.")
    parser.add_argument("--overwrite", action="store_true",
                         help="Re-upload even if matched variants already have media attached.")
    parser.add_argument("--limit", type=int, default=0,
                         help="Only process the first N swatch files, then stop.")
    parser.add_argument("--log-csv", type=Path, default=None,
                         help="Manifest CSV path (default: <library-root>/variant_image_upload_log.csv)")
    args = parser.parse_args()

    library_root = args.library_root.resolve()
    if not library_root.is_dir():
        print(f"Library root not found: {library_root}", file=sys.stderr)
        sys.exit(1)

    domain = os.environ.get("SHOPIFY_STORE_DOMAIN")
    token = os.environ.get("SHOPIFY_ACCESS_TOKEN")
    if not domain:
        domain = input("SHOPIFY_STORE_DOMAIN not set. Enter store domain (e.g. new26-forwardoutdoor.myshopify.com): ").strip()
    if not token:
        token = getpass.getpass("SHOPIFY_ACCESS_TOKEN not set. Enter Admin API access token: ").strip()
    if not domain or not token:
        print("Store domain and access token are required.", file=sys.stderr)
        sys.exit(1)

    client = ShopifyClient(domain, token)

    log_csv = args.log_csv or (library_root / "variant_image_upload_log.csv")

    targets = list(find_swatch_targets(library_root))
    print(f"Found {len(targets)} swatch image(s).")
    if args.limit:
        targets = targets[: args.limit]
        print(f"Limit mode: processing {len(targets)} image(s).")

    rows = []
    for path in targets:
        row = process_swatch(path, client, args.dry_run, args.overwrite)
        rows.append(row)
        rel = path.relative_to(library_root)
        print(f"[{row.status}] {rel} -> {row.product_title or '-'} "
              f"({row.variant_count} variants)" + (f" :: {row.reason}" if row.reason else ""))

    if not args.dry_run:
        with open(log_csv, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["file_path", "color_sku", "product_title", "product_id",
                              "variant_count", "status", "reason"])
            for row in rows:
                writer.writerow([row.file_path, row.color_sku, row.product_title, row.product_id,
                                  row.variant_count, row.status, row.reason])
        print(f"\nManifest written to {log_csv}")

    counts = {}
    for row in rows:
        counts[row.status] = counts.get(row.status, 0) + 1
    for status, count in sorted(counts.items()):
        print(f"  {status}: {count}")


if __name__ == "__main__":
    main()
